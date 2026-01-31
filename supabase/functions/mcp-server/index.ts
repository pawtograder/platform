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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
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
        student_profile_id: { type: "string", description: "The profile ID of the student" },
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

/**
 * Batch fetch profile names for multiple profile IDs
 */
async function getProfileNames(
  supabase: SupabaseClient<Database>,
  profileIds: (string | null)[]
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(profileIds.filter((id): id is string => id !== null))];
  if (uniqueIds.length === 0) return new Map();

  const { data } = await supabase.from("profiles").select("id, name").in("id", uniqueIds.slice(0, MAX_ROWS));

  const map = new Map<string, string>();
  if (data) {
    for (const profile of data) {
      if (profile.name) map.set(profile.id, profile.name);
    }
  }
  return map;
}

/**
 * Batch check if profile IDs are staff (instructor/grader) in a class
 */
async function getStaffProfileIds(
  supabase: SupabaseClient<Database>,
  profileIds: (string | null)[],
  classId: number
): Promise<Set<string>> {
  const uniqueIds = [...new Set(profileIds.filter((id): id is string => id !== null))];
  if (uniqueIds.length === 0) return new Set();

  const { data } = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("class_id", classId)
    .in("private_profile_id", uniqueIds.slice(0, MAX_ROWS))
    .in("role", ["instructor", "grader"]);

  const set = new Set<string>();
  if (data) {
    for (const role of data) {
      if (role.private_profile_id) set.add(role.private_profile_id);
    }
  }
  return set;
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
  // Fetch submission with profile name joined
  const { data: submission, error: subError } = await supabase
    .from("submissions")
    .select("id, assignment_id, created_at, sha, repository, ordinal, is_active, profile_id, profiles!inner(name)")
    .eq("id", submissionId)
    .eq("class_id", classId)
    .single();

  if (subError || !submission) return null;

  const studentName = (submission.profiles as unknown as { name: string })?.name || null;

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
    student_name: studentName,
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
  // Single query with joins for help request, student name, and queue name
  const { data: helpRequest, error } = await supabase
    .from("help_requests")
    .select(
      `
      id, request, status, created_at, updated_at, created_by,
      referenced_submission_id,
      help_queues!inner(name),
      profiles!help_requests_created_by_fkey(name)
    `
    )
    .eq("id", helpRequestId)
    .eq("class_id", classId)
    .single();

  if (error || !helpRequest) return null;

  const studentName = (helpRequest.profiles as unknown as { name: string })?.name || null;
  const helpQueueName = (helpRequest.help_queues as unknown as { name: string })?.name || "Unknown Queue";

  // Parallel fetch: submission, messages
  const [submissionResult, messagesResult] = await Promise.all([
    helpRequest.referenced_submission_id
      ? getSubmission(supabase, helpRequest.referenced_submission_id, classId, true, true)
      : Promise.resolve(null),
    supabase
      .from("help_requests_messages")
      .select("id, content, created_at, profile_id")
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

  // Batch fetch profile names and staff status for messages
  const messageProfileIds = messagesData.map((m) => m.profile_id);
  const [profileNames, staffIds] = await Promise.all([
    getProfileNames(supabase, messageProfileIds),
    getStaffProfileIds(supabase, messageProfileIds, classId)
  ]);

  const messages = messagesData.map((msg) => ({
    id: msg.id,
    content: msg.content,
    created_at: msg.created_at,
    author_name: msg.profile_id ? profileNames.get(msg.profile_id) || null : null,
    is_staff: msg.profile_id ? staffIds.has(msg.profile_id) : false
  }));

  return {
    id: helpRequest.id,
    request: helpRequest.request,
    status: helpRequest.status,
    created_at: helpRequest.created_at,
    updated_at: helpRequest.updated_at,
    assignment,
    submission,
    latest_submission: latestSubmission,
    student_profile_id: helpRequest.created_by,
    student_name: studentName,
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
  // Single query with joins for thread, author name, and topic
  const { data: thread, error } = await supabase
    .from("discussion_threads")
    .select(
      `
      id, subject, body, created_at, updated_at, is_question,
      children_count, author, answer, topic_id,
      discussion_topics!inner(assignment_id),
      profiles!discussion_threads_author_fkey(name)
    `
    )
    .eq("id", threadId)
    .eq("class_id", classId)
    .single();

  if (error || !thread) return null;

  const authorName = (thread.profiles as unknown as { name: string })?.name || null;
  const topic = thread.discussion_topics as unknown as { assignment_id: number | null };

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
    const [profileNames, staffIds] = await Promise.all([
      getProfileNames(supabase, replyAuthorIds),
      getStaffProfileIds(supabase, replyAuthorIds, classId)
    ]);

    replies = repliesData.data.map((reply) => ({
      id: reply.id,
      body: reply.body,
      created_at: reply.created_at,
      author_name: reply.author ? profileNames.get(reply.author) || null : null,
      is_staff: reply.author ? staffIds.has(reply.author) : false,
      is_answer: thread.answer === reply.id
    }));
  }

  return {
    id: thread.id,
    subject: thread.subject,
    body: thread.body,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    is_question: thread.is_question,
    children_count: thread.children_count,
    author_profile_id: thread.author,
    author_name: authorName,
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

  // Build query with joins to get assignment info for filtering
  let query = supabase
    .from("help_requests")
    .select(
      `
      id, request, status, created_at, updated_at, created_by,
      referenced_submission_id,
      help_queues!inner(name),
      profiles!help_requests_created_by_fkey(name)
    `
    )
    .eq("class_id", classId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (options.status) {
    query = query.eq("status", options.status);
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

  // Return lightweight results for search (no full submission/messages context)
  return helpRequests.map((hr) => ({
    id: hr.id,
    request: hr.request,
    status: hr.status,
    created_at: hr.created_at,
    updated_at: hr.updated_at,
    student_profile_id: hr.created_by,
    student_name: (hr.profiles as unknown as { name: string })?.name || null,
    help_queue_name: (hr.help_queues as unknown as { name: string })?.name || "Unknown Queue",
    has_submission: !!hr.referenced_submission_id
  }));
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

  // Build query with author profile joined
  let query = supabase
    .from("discussion_threads")
    .select(
      `
      id, subject, body, created_at, updated_at, is_question,
      children_count, author, answer, topic_id,
      profiles!discussion_threads_author_fkey(name)
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

  // Return lightweight results for search (no replies/submission context)
  return data.map((thread) => ({
    id: thread.id,
    subject: thread.subject,
    body: thread.body,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    is_question: thread.is_question,
    children_count: thread.children_count,
    author_profile_id: thread.author,
    author_name: (thread.profiles as unknown as { name: string })?.name || null,
    has_answer: thread.answer !== null
  }));
}

async function getSubmissionsForStudent(
  supabase: SupabaseClient<Database>,
  studentProfileId: string,
  assignmentId: number,
  classId: number
) {
  // Limit to reasonable number of submissions
  const limit = Math.min(50, MAX_ROWS);

  const { data: submissions, error } = await supabase
    .from("submissions")
    .select("id")
    .eq("profile_id", studentProfileId)
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

  // Verify user has access to the class
  const classId = args.class_id as number;
  if (classId) {
    const { data: roleData } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("class_id", classId)
      .in("role", ["instructor", "grader"])
      .maybeSingle();

    if (!roleData) {
      throw new Error("Access denied: You must be an instructor or grader in this class");
    }
  }

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
// Main Handler
// =============================================================================

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only accept POST requests
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
    updateTokenLastUsed(context.tokenId).catch(() => {});

    // Parse the MCP request
    const mcpRequest = (await req.json()) as MCPRequest;

    // Handle the request
    const response = await handleMCPRequest(mcpRequest, context);

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
