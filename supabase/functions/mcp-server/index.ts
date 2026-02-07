/**
 * Pawtograder MCP Server Edge Function
 *
 * This edge function provides an MCP-compatible server for AI assistants
 * to help TAs support students who are struggling with errors in their
 * programming assignments.
 *
 * Authentication:
 * - Uses long-lived API tokens (JWTs signed with MCP_JWT_SECRET)
 * - Mints short-lived Supabase JWTs for RLS enforcement
 * - Restricted to instructors and graders only
 *
 * Privacy:
 * - Never exposes data from the "users" table
 * - Never exposes the "is_private_profile" field
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  authenticateMCPRequest,
  requireScope,
  MCPAuthContext,
  MCPAuthError,
  updateTokenLastUsed
} from "../_shared/MCPAuth.ts";

// Initialize Sentry if configured
if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA")
  });
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept, mcp-session-id, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
};

/**
 * Sanitize a string for use in PostgREST filter expressions.
 * Escapes SQL wildcards and PostgREST reserved characters to prevent injection.
 */
function sanitizeForPostgrestFilter(input: string): string {
  // Escape SQL wildcards that could be used for injection
  // % and _ are SQL LIKE wildcards
  // Also escape backslash which is the escape character
  return input
    .replace(/\\/g, "\\\\") // Escape backslashes first
    .replace(/%/g, "\\%") // Escape percent
    .replace(/_/g, "\\_") // Escape underscore
    .replace(/,/g, "\\,") // Escape comma (PostgREST OR separator)
    .replace(/\(/g, "\\(") // Escape parentheses
    .replace(/\)/g, "\\)")
    .replace(/\./g, "\\."); // Escape dot (PostgREST operator separator)
}

// Type definitions for MCP protocol
interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// Tool definitions
const TOOLS = {
  get_help_request: {
    name: "get_help_request",
    description:
      "Get a help request with full context including the student's question, linked assignment (with handout URL), submission details, and conversation messages.",
    inputSchema: {
      type: "object",
      properties: {
        help_request_id: { type: "number", description: "The ID of the help request to fetch" },
        class_id: { type: "number", description: "The class ID where the help request exists" }
      },
      required: ["help_request_id", "class_id"]
    },
    requiredScope: "mcp:read" as const
  },
  get_discussion_thread: {
    name: "get_discussion_thread",
    description:
      "Get a discussion thread with full context including the question, assignment (with handout URL), and replies.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "number", description: "The ID of the discussion thread to fetch" },
        class_id: { type: "number", description: "The class ID where the thread exists" },
        include_replies: { type: "boolean", description: "Whether to include replies", default: true }
      },
      required: ["thread_id", "class_id"]
    },
    requiredScope: "mcp:read" as const
  },
  get_submission: {
    name: "get_submission",
    description:
      "Get a submission with full grader results including test outputs, build output, lint results, and error information.",
    inputSchema: {
      type: "object",
      properties: {
        submission_id: { type: "number", description: "The ID of the submission to fetch" },
        class_id: { type: "number", description: "The class ID where the submission exists" },
        include_test_output: { type: "boolean", description: "Whether to include test output", default: true },
        include_files: { type: "boolean", description: "Whether to include submission files", default: true }
      },
      required: ["submission_id", "class_id"]
    },
    requiredScope: "mcp:read" as const
  },
  get_submissions_for_student: {
    name: "get_submissions_for_student",
    description: "Get all submissions for a student on a specific assignment.",
    inputSchema: {
      type: "object",
      properties: {
        student_profile_id: { type: "string", description: "The public profile ID of the student" },
        assignment_id: { type: "number", description: "The assignment ID" },
        class_id: { type: "number", description: "The class ID" }
      },
      required: ["student_profile_id", "assignment_id", "class_id"]
    },
    requiredScope: "mcp:read" as const
  },
  get_assignment: {
    name: "get_assignment",
    description: "Get assignment details including title, description, handout URL, due date, and points.",
    inputSchema: {
      type: "object",
      properties: {
        assignment_id: { type: "number", description: "The ID of the assignment to fetch" },
        class_id: { type: "number", description: "The class ID where the assignment exists" }
      },
      required: ["assignment_id", "class_id"]
    },
    requiredScope: "mcp:read" as const
  },
  search_help_requests: {
    name: "search_help_requests",
    description: "Search help requests in a class, optionally filtered by assignment or status.",
    inputSchema: {
      type: "object",
      properties: {
        class_id: { type: "number", description: "The class ID to search in" },
        assignment_id: { type: "number", description: "Filter by assignment ID" },
        status: { type: "string", description: "Filter by status" },
        limit: { type: "number", description: "Maximum number of results", default: 20 }
      },
      required: ["class_id"]
    },
    requiredScope: "mcp:read" as const
  },
  search_discussion_threads: {
    name: "search_discussion_threads",
    description:
      "Search discussion threads in a class, optionally filtered by assignment, question status, or search query.",
    inputSchema: {
      type: "object",
      properties: {
        class_id: { type: "number", description: "The class ID to search in" },
        assignment_id: { type: "number", description: "Filter by assignment ID" },
        is_question: { type: "boolean", description: "Filter to only questions" },
        search_query: { type: "string", description: "Search query for subject/body" },
        limit: { type: "number", description: "Maximum number of results", default: 20 }
      },
      required: ["class_id"]
    },
    requiredScope: "mcp:read" as const
  }
};

// =============================================================================
// Data Access Functions (Privacy-Safe)
// These functions NEVER expose user table data or is_private_profile
// =============================================================================

// Maximum rows per query (Supabase limit)
const MAX_ROWS = 1000;

// =============================================================================
// Global Profile Cache (across all requests)
// =============================================================================

// Cache TTL: 5 minutes (profile data rarely changes)
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedProfile {
  publicProfileId: string;
  publicName: string | null;
  cachedAt: number;
}

interface CachedStaff {
  staffIds: Set<string>;
  cachedAt: number;
}

/**
 * Global cache for profile lookups across requests.
 * Keyed by classId since profiles are class-specific.
 * Uses TTL to eventually refresh stale data.
 */
const profileCache = {
  // Key: `${classId}:${privateProfileId}` -> public profile info
  privateToPublic: new Map<string, CachedProfile>(),
  // Key: `${classId}:${publicProfileId}` -> privateProfileId
  publicToPrivate: new Map<string, { privateId: string; cachedAt: number }>(),
  // Key: classId -> all staff private profile IDs
  staffByClass: new Map<number, CachedStaff>()
};

function makePrivateKey(classId: number, privateId: string): string {
  return `${classId}:${privateId}`;
}

function makePublicKey(classId: number, publicId: string): string {
  return `${classId}:${publicId}`;
}

function isExpired(cachedAt: number): boolean {
  return Date.now() - cachedAt > PROFILE_CACHE_TTL_MS;
}

function getCachedPublicProfile(classId: number, privateId: string): CachedProfile | null {
  const cached = profileCache.privateToPublic.get(makePrivateKey(classId, privateId));
  if (cached && !isExpired(cached.cachedAt)) return cached;
  return null;
}

function setCachedPublicProfile(classId: number, privateId: string, publicId: string, publicName: string | null): void {
  const now = Date.now();
  profileCache.privateToPublic.set(makePrivateKey(classId, privateId), {
    publicProfileId: publicId,
    publicName,
    cachedAt: now
  });
  profileCache.publicToPrivate.set(makePublicKey(classId, publicId), {
    privateId,
    cachedAt: now
  });
}

function getCachedPrivateId(classId: number, publicId: string): string | null {
  const cached = profileCache.publicToPrivate.get(makePublicKey(classId, publicId));
  if (cached && !isExpired(cached.cachedAt)) return cached.privateId;
  return null;
}

function getCachedStaffIds(classId: number): Set<string> | null {
  const cached = profileCache.staffByClass.get(classId);
  if (cached && !isExpired(cached.cachedAt)) return cached.staffIds;
  return null;
}

function setCachedStaffIds(classId: number, staffIds: Set<string>): void {
  profileCache.staffByClass.set(classId, { staffIds, cachedAt: Date.now() });
}

/**
 * Translate private profile IDs to public profile IDs via user_roles.
 * Uses and populates the global cache.
 */
async function getPublicProfiles(
  supabase: SupabaseClient<Database>,
  privateProfileIds: (string | null)[],
  classId: number
): Promise<Map<string, { publicProfileId: string; publicName: string | null }>> {
  const uniqueIds = [...new Set(privateProfileIds.filter((id): id is string => id !== null))];
  if (uniqueIds.length === 0) return new Map();

  // Check cache first, collect missing IDs
  const result = new Map<string, { publicProfileId: string; publicName: string | null }>();
  const missingIds: string[] = [];

  for (const id of uniqueIds) {
    const cached = getCachedPublicProfile(classId, id);
    if (cached) {
      result.set(id, { publicProfileId: cached.publicProfileId, publicName: cached.publicName });
    } else {
      missingIds.push(id);
    }
  }

  // Fetch missing from DB
  if (missingIds.length > 0) {
    const { data } = await supabase
      .from("user_roles")
      .select("private_profile_id, public_profile_id, profiles!user_roles_public_profile_id_fkey(name)")
      .eq("class_id", classId)
      .in("private_profile_id", missingIds.slice(0, MAX_ROWS));

    if (data) {
      for (const role of data) {
        const publicName = (role.profiles as unknown as { name: string })?.name || null;
        setCachedPublicProfile(classId, role.private_profile_id, role.public_profile_id, publicName);
        result.set(role.private_profile_id, {
          publicProfileId: role.public_profile_id,
          publicName
        });
      }
    }
  }

  return result;
}

/**
 * Translate a public profile ID to private profile ID for queries.
 * Uses and populates the global cache.
 */
async function getPrivateProfileId(
  supabase: SupabaseClient<Database>,
  publicProfileId: string,
  classId: number
): Promise<string | null> {
  // Check cache first
  const cached = getCachedPrivateId(classId, publicProfileId);
  if (cached) return cached;

  const { data } = await supabase
    .from("user_roles")
    .select("private_profile_id, profiles!user_roles_public_profile_id_fkey(name)")
    .eq("class_id", classId)
    .eq("public_profile_id", publicProfileId)
    .maybeSingle();

  if (data) {
    const publicName = (data.profiles as unknown as { name: string })?.name || null;
    setCachedPublicProfile(classId, data.private_profile_id, publicProfileId, publicName);
    return data.private_profile_id;
  }

  return null;
}

/**
 * Batch check if profile IDs are staff (instructor/grader) in a class.
 * Uses and populates the global cache.
 */
async function getStaffProfileIds(
  supabase: SupabaseClient<Database>,
  profileIds: (string | null)[],
  classId: number
): Promise<Set<string>> {
  const uniqueIds = [...new Set(profileIds.filter((id): id is string => id !== null))];
  if (uniqueIds.length === 0) return new Set();

  // Check if we have cached staff for this class
  const cachedStaff = getCachedStaffIds(classId);
  if (cachedStaff) {
    // Filter to only requested IDs that are staff
    const result = new Set<string>();
    for (const id of uniqueIds) {
      if (cachedStaff.has(id)) result.add(id);
    }
    return result;
  }

  // Fetch all staff for this class (they're rare, so fetch all once)
  const { data } = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("class_id", classId)
    .in("role", ["instructor", "grader"]);

  const allStaff = new Set<string>();
  if (data) {
    for (const role of data) {
      if (role.private_profile_id) allStaff.add(role.private_profile_id);
    }
  }
  setCachedStaffIds(classId, allStaff);

  // Return only requested IDs that are staff
  const result = new Set<string>();
  for (const id of uniqueIds) {
    if (allStaff.has(id)) result.add(id);
  }
  return result;
}

async function getAssignment(supabase: SupabaseClient<Database>, assignmentId: number, classId: number) {
  const { data, error } = await supabase
    .from("assignments")
    .select("id, title, slug, description, handout_url, due_date, release_date, total_points, has_autograder, class_id")
    .eq("id", assignmentId)
    .eq("class_id", classId)
    .single();

  if (error || !data) return null;
  return data;
}

async function getSubmission(
  supabase: SupabaseClient<Database>,
  submissionId: number,
  classId: number,
  includeTestOutput = true,
  includeFiles = true
) {
  // Fetch submission (profile_id is private profile)
  const { data: submission, error: subError } = await supabase
    .from("submissions")
    .select("id, assignment_id, created_at, sha, repository, ordinal, is_active, profile_id")
    .eq("id", submissionId)
    .eq("class_id", classId)
    .single();

  if (subError || !submission) return null;

  // Translate private profile to public profile
  const publicProfiles = submission.profile_id
    ? await getPublicProfiles(supabase, [submission.profile_id], classId)
    : new Map();
  const publicProfile = submission.profile_id ? publicProfiles.get(submission.profile_id) : null;

  // Parallel fetch: grader result, files (if needed)
  const [graderResult, files] = await Promise.all([
    getGraderResult(supabase, submissionId, classId, includeTestOutput),
    includeFiles ? getSubmissionFiles(supabase, submissionId, classId) : Promise.resolve(null)
  ]);

  return {
    id: submission.id,
    assignment_id: submission.assignment_id,
    created_at: submission.created_at,
    sha: submission.sha,
    repository: submission.repository,
    ordinal: submission.ordinal,
    is_active: submission.is_active,
    student_profile_id: publicProfile?.publicProfileId || null,
    student_name: publicProfile?.publicName || null,
    grader_result: graderResult,
    files
  };
}

async function getGraderResult(
  supabase: SupabaseClient<Database>,
  submissionId: number,
  classId: number,
  includeTestOutput: boolean
) {
  const { data: graderData } = await supabase
    .from("grader_results")
    .select("id, score, max_score, lint_passed, lint_output, lint_output_format, errors, execution_time, ret_code")
    .eq("submission_id", submissionId)
    .eq("class_id", classId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!graderData) return null;

  // Parallel fetch tests and build output
  const [testsData, outputData] = await Promise.all([
    supabase
      .from("grader_result_tests")
      .select("id, name, part, score, max_score, output, output_format, is_released")
      .eq("grader_result_id", graderData.id)
      .order("id", { ascending: true })
      .limit(MAX_ROWS),
    supabase
      .from("grader_result_output")
      .select("stdout, stderr, combined_output, output_format")
      .eq("grader_result_id", graderData.id)
      .maybeSingle()
  ]);

  const tests = (testsData.data || []).map((test) => ({
    id: test.id,
    name: test.name,
    part: test.part,
    score: test.score,
    max_score: test.max_score,
    output: includeTestOutput ? test.output : null,
    output_format: test.output_format,
    is_released: test.is_released
  }));

  return {
    id: graderData.id,
    score: graderData.score,
    max_score: graderData.max_score,
    lint_passed: graderData.lint_passed,
    lint_output: graderData.lint_output,
    lint_output_format: graderData.lint_output_format,
    errors: graderData.errors,
    execution_time: graderData.execution_time,
    ret_code: graderData.ret_code,
    tests,
    build_output: outputData.data || null
  };
}

async function getSubmissionFiles(supabase: SupabaseClient<Database>, submissionId: number, classId: number) {
  const { data, error } = await supabase
    .from("submission_files")
    .select("id, name, contents")
    .eq("submission_id", submissionId)
    .eq("class_id", classId)
    .order("name", { ascending: true })
    .limit(MAX_ROWS);

  if (error || !data) return [];
  return data;
}

async function getLatestSubmissionForStudent(
  supabase: SupabaseClient<Database>,
  studentProfileId: string,
  assignmentId: number,
  classId: number,
  includeFiles = true
) {
  const { data: submission } = await supabase
    .from("submissions")
    .select("id")
    .eq("profile_id", studentProfileId)
    .eq("assignment_id", assignmentId)
    .eq("class_id", classId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!submission) return null;
  return getSubmission(supabase, submission.id, classId, true, includeFiles);
}

async function getHelpRequest(supabase: SupabaseClient<Database>, helpRequestId: number, classId: number) {
  // Single query with joins for help request and queue name (created_by is private profile)
  const { data: helpRequest, error } = await supabase
    .from("help_requests")
    .select(
      `
      id, request, status, created_at, updated_at, created_by,
      referenced_submission_id,
      help_queues!inner(name)
    `
    )
    .eq("id", helpRequestId)
    .eq("class_id", classId)
    .single();

  if (error || !helpRequest) return null;

  const helpQueueName = (helpRequest.help_queues as unknown as { name: string })?.name || "Unknown Queue";

  // Translate private profile to public profile for student
  const studentPublicProfiles = helpRequest.created_by
    ? await getPublicProfiles(supabase, [helpRequest.created_by], classId)
    : new Map();
  const studentPublicProfile = helpRequest.created_by ? studentPublicProfiles.get(helpRequest.created_by) : null;

  // Parallel fetch: submission, messages
  const [submissionResult, messagesResult] = await Promise.all([
    helpRequest.referenced_submission_id
      ? getSubmission(supabase, helpRequest.referenced_submission_id, classId, true, true)
      : Promise.resolve(null),
    supabase
      .from("help_request_messages")
      .select("id, message, created_at, author")
      .eq("help_request_id", helpRequestId)
      .order("created_at", { ascending: true })
      .limit(MAX_ROWS)
  ]);

  const submission = submissionResult;
  const messagesData = messagesResult.data || [];

  // Get assignment (if we have submission)
  let assignment = null;
  let latestSubmission = null;

  if (submission) {
    // Parallel fetch: assignment and latest submission
    const [assignmentResult, latestResult] = await Promise.all([
      getAssignment(supabase, submission.assignment_id, classId),
      helpRequest.created_by
        ? getLatestSubmissionForStudent(supabase, helpRequest.created_by, submission.assignment_id, classId, true)
        : Promise.resolve(null)
    ]);

    assignment = assignmentResult;
    latestSubmission = latestResult;

    // Don't include latest if same as referenced
    if (latestSubmission && latestSubmission.id === submission.id) {
      latestSubmission = null;
    }
  }

  // Batch fetch public profiles and staff status for messages
  const messageAuthorIds = messagesData.map((m) => m.author);
  const [publicProfiles, staffIds] = await Promise.all([
    getPublicProfiles(supabase, messageAuthorIds, classId),
    getStaffProfileIds(supabase, messageAuthorIds, classId)
  ]);

  const messages = messagesData.map((msg) => {
    const publicProfile = msg.author ? publicProfiles.get(msg.author) : null;
    return {
      id: msg.id,
      content: msg.message,
      created_at: msg.created_at,
      author_name: publicProfile?.publicName || null,
      is_staff: msg.author ? staffIds.has(msg.author) : false
    };
  });

  return {
    id: helpRequest.id,
    request: helpRequest.request,
    status: helpRequest.status,
    created_at: helpRequest.created_at,
    updated_at: helpRequest.updated_at,
    assignment,
    submission,
    latest_submission: latestSubmission,
    student_profile_id: studentPublicProfile?.publicProfileId || null,
    student_name: studentPublicProfile?.publicName || null,
    help_queue_name: helpQueueName,
    messages
  };
}

async function getDiscussionThread(
  supabase: SupabaseClient<Database>,
  threadId: number,
  classId: number,
  includeReplies = true
) {
  // Single query with joins for thread and topic (author is private profile)
  const { data: thread, error } = await supabase
    .from("discussion_threads")
    .select(
      `
      id, subject, body, created_at, updated_at, is_question,
      children_count, author, answer, topic_id,
      discussion_topics!inner(assignment_id)
    `
    )
    .eq("id", threadId)
    .eq("class_id", classId)
    .single();

  if (error || !thread) return null;

  const topic = thread.discussion_topics as unknown as { assignment_id: number | null };

  // Translate private profile to public profile for author
  const authorPublicProfiles = thread.author ? await getPublicProfiles(supabase, [thread.author], classId) : new Map();
  const authorPublicProfile = thread.author ? authorPublicProfiles.get(thread.author) : null;

  // Parallel fetch: assignment, latest submission, replies
  const [assignment, latestSubmission, repliesData] = await Promise.all([
    topic?.assignment_id ? getAssignment(supabase, topic.assignment_id, classId) : Promise.resolve(null),
    topic?.assignment_id && thread.author
      ? getLatestSubmissionForStudent(supabase, thread.author, topic.assignment_id, classId, true)
      : Promise.resolve(null),
    includeReplies && thread.children_count > 0
      ? supabase
          .from("discussion_threads")
          .select("id, body, created_at, author")
          .eq("root", threadId)
          .eq("class_id", classId)
          .order("created_at", { ascending: true })
          .limit(50)
      : Promise.resolve({ data: null })
  ]);

  // Process replies with batch lookups
  let replies: Array<{
    id: number;
    body: string | null;
    created_at: string;
    author_name: string | null;
    is_staff: boolean;
    is_answer: boolean;
  }> = [];

  if (repliesData.data && repliesData.data.length > 0) {
    const replyAuthorIds = repliesData.data.map((r) => r.author);
    const [publicProfiles, staffIds] = await Promise.all([
      getPublicProfiles(supabase, replyAuthorIds, classId),
      getStaffProfileIds(supabase, replyAuthorIds, classId)
    ]);

    replies = repliesData.data.map((reply) => {
      const publicProfile = reply.author ? publicProfiles.get(reply.author) : null;
      return {
        id: reply.id,
        body: reply.body,
        created_at: reply.created_at,
        author_name: publicProfile?.publicName || null,
        is_staff: reply.author ? staffIds.has(reply.author) : false,
        is_answer: thread.answer === reply.id
      };
    });
  }

  return {
    id: thread.id,
    subject: thread.subject,
    body: thread.body,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    is_question: thread.is_question,
    children_count: thread.children_count,
    author_profile_id: authorPublicProfile?.publicProfileId || null,
    author_name: authorPublicProfile?.publicName || null,
    assignment,
    latest_submission: latestSubmission,
    replies
  };
}

async function searchHelpRequests(
  supabase: SupabaseClient<Database>,
  classId: number,
  options: { assignmentId?: number; status?: string; limit?: number } = {}
) {
  const limit = Math.min(options.limit || 20, MAX_ROWS);

  // Build query with joins to get queue name (created_by is private profile)
  let query = supabase
    .from("help_requests")
    .select(
      `
      id, request, status, created_at, updated_at, created_by,
      referenced_submission_id,
      help_queues!inner(name)
    `
    )
    .eq("class_id", classId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (options.status) {
    query = query.eq("status", options.status as Database["public"]["Enums"]["help_request_status"]);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  // If filtering by assignment, we need to check submission -> assignment
  // Fetch all at once and filter in memory
  let helpRequests = data;

  if (options.assignmentId) {
    // Get submission assignment IDs in batch
    const submissionIds = helpRequests
      .filter((hr) => hr.referenced_submission_id)
      .map((hr) => hr.referenced_submission_id as number);

    if (submissionIds.length > 0) {
      const { data: submissions } = await supabase
        .from("submissions")
        .select("id, assignment_id")
        .in("id", submissionIds.slice(0, MAX_ROWS));

      const submissionAssignmentMap = new Map<number, number>();
      if (submissions) {
        for (const sub of submissions) {
          submissionAssignmentMap.set(sub.id, sub.assignment_id);
        }
      }

      // Filter to only those with matching assignment
      helpRequests = helpRequests.filter((hr) => {
        if (!hr.referenced_submission_id) return false;
        return submissionAssignmentMap.get(hr.referenced_submission_id) === options.assignmentId;
      });
    } else {
      helpRequests = [];
    }
  }

  // Limit results after filtering
  helpRequests = helpRequests.slice(0, limit);

  // Batch fetch public profiles for all results
  const privateProfileIds = helpRequests.map((hr) => hr.created_by).filter((id): id is string => id !== null);
  const publicProfiles = await getPublicProfiles(supabase, privateProfileIds, classId);

  // Return lightweight results for search (no full submission/messages context)
  return helpRequests.map((hr) => {
    const publicProfile = hr.created_by ? publicProfiles.get(hr.created_by) : null;
    return {
      id: hr.id,
      request: hr.request,
      status: hr.status,
      created_at: hr.created_at,
      updated_at: hr.updated_at,
      student_profile_id: publicProfile?.publicProfileId || null,
      student_name: publicProfile?.publicName || null,
      help_queue_name: (hr.help_queues as unknown as { name: string })?.name || "Unknown Queue",
      has_submission: !!hr.referenced_submission_id
    };
  });
}

async function searchDiscussionThreads(
  supabase: SupabaseClient<Database>,
  classId: number,
  options: { assignmentId?: number; isQuestion?: boolean; searchQuery?: string; limit?: number } = {}
) {
  const limit = Math.min(options.limit || 20, MAX_ROWS);

  let topicIds: number[] | null = null;
  if (options.assignmentId) {
    const { data: topics } = await supabase
      .from("discussion_topics")
      .select("id")
      .eq("class_id", classId)
      .eq("assignment_id", options.assignmentId)
      .limit(MAX_ROWS);

    if (topics && topics.length > 0) {
      topicIds = topics.map((t) => t.id);
    } else {
      return [];
    }
  }

  // Build query (author is private profile)
  let query = supabase
    .from("discussion_threads")
    .select(
      `
      id, subject, body, created_at, updated_at, is_question,
      children_count, author, answer, topic_id
    `
    )
    .eq("class_id", classId)
    .is("parent", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (topicIds) {
    query = query.in("topic_id", topicIds);
  }

  if (options.isQuestion !== undefined) {
    query = query.eq("is_question", options.isQuestion);
  }

  if (options.searchQuery) {
    const sanitized = sanitizeForPostgrestFilter(options.searchQuery);
    query = query.or(`subject.ilike.%${sanitized}%,body.ilike.%${sanitized}%`);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  // Batch fetch public profiles for all results
  const authorIds = data.map((thread) => thread.author).filter((id): id is string => id !== null);
  const publicProfiles = await getPublicProfiles(supabase, authorIds, classId);

  // Return lightweight results for search (no replies/submission context)
  return data.map((thread) => {
    const publicProfile = thread.author ? publicProfiles.get(thread.author) : null;
    return {
      id: thread.id,
      subject: thread.subject,
      body: thread.body,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
      is_question: thread.is_question,
      children_count: thread.children_count,
      author_profile_id: publicProfile?.publicProfileId || null,
      author_name: publicProfile?.publicName || null,
      has_answer: thread.answer !== null
    };
  });
}

async function getSubmissionsForStudent(
  supabase: SupabaseClient<Database>,
  publicProfileId: string,
  assignmentId: number,
  classId: number
) {
  // Translate public profile ID to private profile ID for querying
  const privateProfileId = await getPrivateProfileId(supabase, publicProfileId, classId);
  if (!privateProfileId) return [];

  // Limit to reasonable number of submissions
  const limit = Math.min(50, MAX_ROWS);

  const { data: submissions, error } = await supabase
    .from("submissions")
    .select("id")
    .eq("profile_id", privateProfileId)
    .eq("assignment_id", assignmentId)
    .eq("class_id", classId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !submissions || submissions.length === 0) return [];

  // Fetch all submissions in parallel
  const results = await Promise.all(submissions.map((sub) => getSubmission(supabase, sub.id, classId, true, true)));

  // Filter out null results
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

// =============================================================================
// Tool Execution
// =============================================================================

async function executeTool(toolName: string, args: Record<string, unknown>, context: MCPAuthContext): Promise<unknown> {
  const tool = TOOLS[toolName as keyof typeof TOOLS];
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // Check scope
  requireScope(context, tool.requiredScope);

  // Execute the tool
  switch (toolName) {
    case "get_help_request":
      return await getHelpRequest(context.supabase, args.help_request_id as number, args.class_id as number);

    case "get_discussion_thread":
      return await getDiscussionThread(
        context.supabase,
        args.thread_id as number,
        args.class_id as number,
        args.include_replies !== false
      );

    case "get_submission":
      return await getSubmission(
        context.supabase,
        args.submission_id as number,
        args.class_id as number,
        args.include_test_output !== false,
        args.include_files !== false
      );

    case "get_submissions_for_student":
      return await getSubmissionsForStudent(
        context.supabase,
        args.student_profile_id as string,
        args.assignment_id as number,
        args.class_id as number
      );

    case "get_assignment":
      return await getAssignment(context.supabase, args.assignment_id as number, args.class_id as number);

    case "search_help_requests":
      return await searchHelpRequests(context.supabase, args.class_id as number, {
        assignmentId: args.assignment_id as number | undefined,
        status: args.status as string | undefined,
        limit: args.limit as number | undefined
      });

    case "search_discussion_threads":
      return await searchDiscussionThreads(context.supabase, args.class_id as number, {
        assignmentId: args.assignment_id as number | undefined,
        isQuestion: args.is_question as boolean | undefined,
        searchQuery: args.search_query as string | undefined,
        limit: args.limit as number | undefined
      });

    default:
      throw new Error(`Tool not implemented: ${toolName}`);
  }
}

// =============================================================================
// MCP Protocol Handler
// =============================================================================

async function handleMCPRequest(request: MCPRequest, context: MCPAuthContext): Promise<MCPResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: {
              name: "pawtograder",
              version: "0.1.0"
            },
            capabilities: {
              tools: {}
            }
          }
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: Object.values(TOOLS).map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
          }
        };

      case "tools/call": {
        const toolName = params?.name as string;
        const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

        const result = await executeTool(toolName, toolArgs, context);

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          }
        };
      }

      case "notifications/initialized":
        // Client acknowledges initialization - no response needed for notifications
        return {
          jsonrpc: "2.0",
          id,
          result: {}
        };

      case "ping":
        return {
          jsonrpc: "2.0",
          id,
          result: {}
        };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        };
    }
  } catch (error) {
    Sentry.captureException(error, {
      tags: { component: "mcp_handler", method }
    });
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Unknown error"
      }
    };
  }
}

// =============================================================================
// SSE Stream Management
// =============================================================================

interface SSEStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  eventId: number;
}

function createSSEStream(): { stream: ReadableStream<Uint8Array>; sse: SSEStream } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // Client disconnected
    }
  });

  // The start() callback is called synchronously, so controller should be set
  if (!controller) {
    throw new Error("Failed to initialize SSE stream controller");
  }

  return {
    stream,
    sse: {
      controller,
      encoder,
      eventId: 0
    }
  };
}

function sendSSEEvent(
  sse: SSEStream,
  event: string,
  data: unknown,
  options: { includeId?: boolean; raw?: boolean } = {}
): void {
  const { includeId = true, raw = false } = options;
  const lines: string[] = [];
  if (includeId) {
    lines.push(`id: ${++sse.eventId}`);
  }
  lines.push(`event: ${event}`);
  // For raw mode, send data as-is (useful for endpoint event which is just a URL string)
  // For normal mode, JSON encode the data
  lines.push(`data: ${raw ? String(data) : JSON.stringify(data)}`);
  lines.push(""); // Empty line to end the event

  const message = lines.join("\n") + "\n";
  sse.controller.enqueue(sse.encoder.encode(message));
}

function sendSSEMessage(sse: SSEStream, data: unknown): void {
  sendSSEEvent(sse, "message", data, { includeId: true, raw: false });
}

function closeSSEStream(sse: SSEStream): void {
  try {
    sse.controller.close();
  } catch {
    // Already closed
  }
}

/**
 * Get the full endpoint URL for the MCP server.
 * Uses EDGE_FUNCTIONS_URL environment variable for the base URL.
 */
function getEndpointUrl(req: Request): string {
  // Use EDGE_FUNCTIONS_URL as the authoritative base URL
  const edgeFunctionsUrl = Deno.env.get("EDGE_FUNCTIONS_URL");

  if (edgeFunctionsUrl) {
    return `${edgeFunctionsUrl}/functions/v1/mcp-server`;
  }

  // Fallback: construct from request
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  return `${proto}://${host}/functions/v1/mcp-server`;
}

// =============================================================================
// Main Handler
// =============================================================================

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Handle DELETE for session termination (Streamable HTTP 2025-03-26)
  if (req.method === "DELETE") {
    return new Response(null, {
      status: 202,
      headers: corsHeaders
    });
  }

  // Handle GET for SSE stream (supports both transports)
  if (req.method === "GET") {
    const acceptHeader = req.headers.get("accept") || "";

    // Check if client accepts SSE
    if (!acceptHeader.includes("text/event-stream")) {
      return new Response(JSON.stringify({ error: "Must accept text/event-stream" }), {
        status: 406,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    try {
      // Authenticate the request
      const authHeader = req.headers.get("authorization");
      const context = await authenticateMCPRequest(authHeader);

      // Update last used timestamp asynchronously
      updateTokenLastUsed(context.tokenId).catch((err) => {
        Sentry.captureException(err, {
          tags: { operation: "update_token_last_used", tokenId: context.tokenId }
        });
      });

      // Create SSE stream
      const { stream, sse } = createSSEStream();

      // For backwards compatibility with HTTP+SSE (2024-11-05),
      // send an endpoint event with the URL for POST messages
      const postEndpoint = getEndpointUrl(req);
      sendSSEEvent(sse, "endpoint", postEndpoint, { includeId: false, raw: true });

      // Keep the stream open for server-to-client messages
      return new Response(stream, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        }
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: { component: "mcp_server", method: "GET" }
      });

      const status = error instanceof MCPAuthError ? 401 : 500;
      const message = error instanceof Error ? error.message : "Internal server error";

      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }

  // Handle POST for JSON-RPC messages
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    // Authenticate the request
    const authHeader = req.headers.get("authorization");
    const context = await authenticateMCPRequest(authHeader);

    // Update last used timestamp asynchronously
    updateTokenLastUsed(context.tokenId).catch((err) => {
      Sentry.captureException(err, {
        tags: { operation: "update_token_last_used", tokenId: context.tokenId }
      });
    });

    // Parse the MCP request (can be single or batch)
    const body = await req.json();

    // Check Accept header to determine response format
    const acceptHeader = req.headers.get("accept") || "";
    const acceptsSSE = acceptHeader.includes("text/event-stream");
    const acceptsJSON = acceptHeader.includes("application/json") || acceptHeader.includes("*/*") || !acceptHeader;

    // Handle batch requests
    if (Array.isArray(body)) {
      // Check if it's all notifications/responses (no requests needing response)
      const hasRequests = body.some((msg) => "method" in msg && msg.id !== undefined && msg.id !== null);

      if (!hasRequests) {
        return new Response(null, {
          status: 202,
          headers: corsHeaders
        });
      }

      // Process batch requests
      const responses: MCPResponse[] = [];
      for (const mcpRequest of body) {
        if ("method" in mcpRequest && mcpRequest.id !== undefined && mcpRequest.id !== null) {
          const response = await handleMCPRequest(mcpRequest as MCPRequest, context);
          responses.push(response);
        }
      }

      if (acceptsSSE && !acceptsJSON) {
        const { stream, sse } = createSSEStream();
        for (const response of responses) {
          sendSSEMessage(sse, response);
        }
        closeSSEStream(sse);

        return new Response(stream, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache"
          }
        });
      }

      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Single request
    const mcpRequest = body as MCPRequest;

    // Check if it's a notification (no id or null id)
    if (mcpRequest.id === undefined || mcpRequest.id === null) {
      return new Response(null, {
        status: 202,
        headers: corsHeaders
      });
    }

    // Handle the request
    const response = await handleMCPRequest(mcpRequest, context);

    // Return as JSON (default for single requests)
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { component: "mcp_server" }
    });

    const status = error instanceof MCPAuthError ? 401 : 500;
    const message = error instanceof Error ? error.message : "Internal server error";

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: status === 401 ? -32000 : -32603,
          message
        }
      }),
      {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
});
