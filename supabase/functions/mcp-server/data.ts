/**
 * Data access layer for Pawtograder MCP Server Edge Function
 * Fetches data from Supabase while applying privacy filters
 *
 * IMPORTANT: This module NEVER exposes:
 * - Data from the "users" table
 * - The "is_private_profile" field from profiles
 * - Any other sensitive user information
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  AssignmentContext,
  HelpRequestContext,
  HelpRequestMessage,
  DiscussionThreadContext,
  DiscussionReplyContext,
  SubmissionContext,
  SubmissionFileContext,
  GraderResultContext,
  TestResultContext,
  BuildOutputContext,
  SafeProfile,
  HandoutFileContext,
  GraderFileContext
} from "./types.ts";
import * as github from "../_shared/GitHubWrapper.ts";

/**
 * Get a safe profile (name and avatar only, no sensitive fields)
 * Returns null if profile is private or not found
 */
async function getSafeProfile(supabase: SupabaseClient, profileId: string | null): Promise<SafeProfile | null> {
  if (!profileId) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, avatar_url, class_id, is_private_profile")
    .eq("id", profileId)
    .single();

  if (error || !data) return null;

  // Enforce privacy: return null if profile is private
  if (data.is_private_profile) return null;

  return {
    id: data.id,
    name: data.name,
    avatar_url: data.avatar_url,
    class_id: data.class_id
  };
}

/**
 * Get profile name only (for display purposes)
 * Returns null if profile not found
 */
async function getProfileName(supabase: SupabaseClient, profileId: string | null): Promise<string | null> {
  if (!profileId) return null;

  const profile = await getSafeProfile(supabase, profileId);
  return profile?.name || null;
}

/**
 * Get assignment context with handout URL
 */
export async function getAssignment(
  supabase: SupabaseClient,
  assignmentId: number,
  classId: number
): Promise<AssignmentContext | null> {
  const { data, error } = await supabase
    .from("assignments")
    .select(
      "id, title, slug, description, handout_url, due_date, release_date, total_points, has_autograder, class_id, template_repo"
    )
    .eq("id", assignmentId)
    .eq("class_id", classId)
    .single();

  if (error || !data) return null;

  return {
    id: data.id,
    title: data.title,
    slug: data.slug,
    description: data.description,
    handout_url: data.handout_url,
    due_date: data.due_date,
    release_date: data.release_date,
    total_points: data.total_points,
    has_autograder: data.has_autograder,
    class_id: data.class_id,
    template_repo: data.template_repo
  };
}

/**
 * Get submission files for a submission
 */
export async function getSubmissionFiles(
  supabase: SupabaseClient,
  submissionId: number,
  classId: number
): Promise<SubmissionFileContext[]> {
  const { data, error } = await supabase
    .from("submission_files")
    .select("id, name, contents")
    .eq("submission_id", submissionId)
    .eq("class_id", classId)
    .order("name", { ascending: true });

  if (error || !data) return [];

  return data.map((file) => ({
    id: file.id,
    name: file.name,
    contents: file.contents
  }));
}

/**
 * Get the latest submission for a student on an assignment
 */
export async function getLatestSubmissionForStudent(
  supabase: SupabaseClient,
  studentProfileId: string,
  assignmentId: number,
  classId: number,
  includeFiles = true
): Promise<SubmissionContext | null> {
  // Get the most recent submission for this student on this assignment
  const { data: submission, error } = await supabase
    .from("submissions")
    .select("id")
    .eq("profile_id", studentProfileId)
    .eq("assignment_id", assignmentId)
    .eq("class_id", classId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !submission) return null;

  return getSubmission(supabase, submission.id, classId, true, includeFiles);
}

/**
 * Get help request with full context
 */
export async function getHelpRequest(
  supabase: SupabaseClient,
  helpRequestId: number,
  classId: number
): Promise<HelpRequestContext | null> {
  // Fetch the help request
  const { data: helpRequest, error: hrError } = await supabase
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

  if (hrError || !helpRequest) return null;

  // Get student name (the creator of the help request)
  const studentName = await getProfileName(supabase, helpRequest.created_by);

  // Get help queue name
  const helpQueueName = (helpRequest.help_queues as unknown as { name: string })?.name || "Unknown Queue";

  // Get linked submission if exists
  let submission: SubmissionContext | null = null;
  if (helpRequest.referenced_submission_id) {
    submission = await getSubmission(
      supabase,
      helpRequest.referenced_submission_id,
      classId,
      true,
      true // include files
    );
  }

  // Get assignment context from submission if available
  let assignment: AssignmentContext | null = null;
  if (submission) {
    assignment = await getAssignment(supabase, submission.assignment_id, classId);
  }

  // Get the latest submission for the student on this assignment
  // This is useful when the help request doesn't reference a specific submission
  let latestSubmission: SubmissionContext | null = null;
  if (assignment && helpRequest.created_by) {
    latestSubmission = await getLatestSubmissionForStudent(
      supabase,
      helpRequest.created_by,
      assignment.id,
      classId,
      true // include files
    );
    // If the referenced submission is the same as the latest, no need to duplicate
    if (latestSubmission && submission && latestSubmission.id === submission.id) {
      latestSubmission = null;
    }
  }

  // Get help request messages
  const { data: messagesData } = await supabase
    .from("help_requests_messages")
    .select("id, content, created_at, profile_id")
    .eq("help_request_id", helpRequestId)
    .order("created_at", { ascending: true });

  const messages: HelpRequestMessage[] = [];
  if (messagesData) {
    // Collect all unique profile_ids for batched queries
    const uniqueProfileIds = [...new Set(messagesData.map((msg) => msg.profile_id).filter(Boolean))];

    // Batch query profiles to get names (respecting privacy)
    const profileNameMap = new Map<string, string | null>();
    if (uniqueProfileIds.length > 0) {
      const { data: profilesData } = await supabase
        .from("profiles")
        .select("id, name, is_private_profile")
        .in("id", uniqueProfileIds);

      if (profilesData) {
        for (const profile of profilesData) {
          // Enforce privacy: only include name if profile is not private
          profileNameMap.set(profile.id, profile.is_private_profile ? null : profile.name);
        }
      }
    }

    // Batch query user_roles to get staff flags
    const isStaffMap = new Map<string, boolean>();
    if (uniqueProfileIds.length > 0) {
      const { data: rolesData } = await supabase
        .from("user_roles")
        .select("private_profile_id")
        .in("private_profile_id", uniqueProfileIds)
        .eq("class_id", classId)
        .in("role", ["instructor", "grader"]);

      if (rolesData) {
        for (const role of rolesData) {
          isStaffMap.set(role.private_profile_id, true);
        }
      }
    }

    // Build messages using lookup maps
    for (const msg of messagesData) {
      const authorName = msg.profile_id ? (profileNameMap.get(msg.profile_id) ?? null) : null;
      const isStaff = msg.profile_id ? (isStaffMap.get(msg.profile_id) ?? false) : false;

      messages.push({
        id: msg.id,
        content: msg.content,
        created_at: msg.created_at,
        author_name: authorName,
        is_staff: isStaff
      });
    }
  }

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

/**
 * Get discussion thread with context
 */
export async function getDiscussionThread(
  supabase: SupabaseClient,
  threadId: number,
  classId: number,
  includeReplies = true
): Promise<DiscussionThreadContext | null> {
  // Fetch the thread
  const { data: thread, error: threadError } = await supabase
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

  if (threadError || !thread) return null;

  // Get author name
  const authorName = await getProfileName(supabase, thread.author);

  // Get assignment context if linked through topic
  let assignment: AssignmentContext | null = null;
  const topic = thread.discussion_topics as unknown as { assignment_id: number | null };
  if (topic?.assignment_id) {
    assignment = await getAssignment(supabase, topic.assignment_id, classId);
  }

  // Get the latest submission for the author on this assignment
  let latestSubmission: SubmissionContext | null = null;
  if (assignment && thread.author) {
    latestSubmission = await getLatestSubmissionForStudent(
      supabase,
      thread.author,
      assignment.id,
      classId,
      true // include files
    );
  }

  // Get replies if requested
  const replies: DiscussionReplyContext[] = [];
  if (includeReplies && thread.children_count > 0) {
    const { data: repliesData } = await supabase
      .from("discussion_threads")
      .select("id, body, created_at, author")
      .eq("root", threadId)
      .eq("class_id", classId)
      .order("created_at", { ascending: true })
      .limit(50); // Limit replies to avoid huge responses

    if (repliesData) {
      // Collect all unique author IDs for batched queries
      const uniqueAuthorIds = [...new Set(repliesData.map((reply) => reply.author).filter(Boolean))];

      // Batch query profiles to get names (respecting privacy)
      const authorNameMap = new Map<string, string | null>();
      if (uniqueAuthorIds.length > 0) {
        const { data: profilesData } = await supabase
          .from("profiles")
          .select("id, name, is_private_profile")
          .in("id", uniqueAuthorIds);

        if (profilesData) {
          for (const profile of profilesData) {
            // Enforce privacy: only include name if profile is not private
            authorNameMap.set(profile.id, profile.is_private_profile ? null : profile.name);
          }
        }
      }

      // Batch query user_roles to get staff flags
      const isStaffMap = new Map<string, boolean>();
      if (uniqueAuthorIds.length > 0) {
        const { data: rolesData } = await supabase
          .from("user_roles")
          .select("private_profile_id")
          .in("private_profile_id", uniqueAuthorIds)
          .eq("class_id", classId)
          .in("role", ["instructor", "grader"]);

        if (rolesData) {
          for (const role of rolesData) {
            isStaffMap.set(role.private_profile_id, true);
          }
        }
      }

      // Build replies using lookup maps
      for (const reply of repliesData) {
        const replyAuthorName = reply.author ? (authorNameMap.get(reply.author) ?? null) : null;
        const isStaff = reply.author ? (isStaffMap.get(reply.author) ?? false) : false;

        replies.push({
          id: reply.id,
          body: reply.body,
          created_at: reply.created_at,
          author_name: replyAuthorName,
          is_staff: isStaff,
          is_answer: thread.answer === reply.id
        });
      }
    }
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

/**
 * Get submission with grader results and optionally files
 */
export async function getSubmission(
  supabase: SupabaseClient,
  submissionId: number,
  classId: number,
  includeTestOutput = true,
  includeFiles = true
): Promise<SubmissionContext | null> {
  // Fetch the submission
  const { data: submission, error: subError } = await supabase
    .from("submissions")
    .select("id, assignment_id, created_at, sha, repository, ordinal, is_active, profile_id")
    .eq("id", submissionId)
    .eq("class_id", classId)
    .single();

  if (subError || !submission) return null;

  // Get student name
  const studentName = await getProfileName(supabase, submission.profile_id);

  // Get grader result if exists
  let graderResult: GraderResultContext | null = null;
  const { data: graderData } = await supabase
    .from("grader_results")
    .select("id, score, max_score, lint_passed, lint_output, lint_output_format, errors, execution_time, ret_code")
    .eq("submission_id", submissionId)
    .eq("class_id", classId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (graderData) {
    // Get test results
    const tests: TestResultContext[] = [];
    const { data: testsData } = await supabase
      .from("grader_result_tests")
      .select("id, name, part, score, max_score, output, output_format, is_released")
      .eq("grader_result_id", graderData.id)
      .order("id", { ascending: true });

    if (testsData) {
      for (const test of testsData) {
        tests.push({
          id: test.id,
          name: test.name,
          part: test.part,
          score: test.score,
          max_score: test.max_score,
          output: includeTestOutput ? test.output : null,
          output_format: test.output_format,
          is_released: test.is_released
        });
      }
    }

    // Get build output if exists
    let buildOutput: BuildOutputContext | null = null;
    const { data: outputData } = await supabase
      .from("grader_result_output")
      .select("stdout, stderr, combined_output, output_format")
      .eq("grader_result_id", graderData.id)
      .maybeSingle();

    if (outputData) {
      buildOutput = {
        stdout: outputData.stdout,
        stderr: outputData.stderr,
        combined_output: outputData.combined_output,
        output_format: outputData.output_format
      };
    }

    graderResult = {
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
      build_output: buildOutput
    };
  }

  // Get submission files if requested
  let files: SubmissionFileContext[] | undefined;
  if (includeFiles) {
    files = await getSubmissionFiles(supabase, submissionId, classId);
  }

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

/**
 * Get all submissions for a student on an assignment
 */
export async function getSubmissionsForStudent(
  supabase: SupabaseClient,
  studentProfileId: string,
  assignmentId: number,
  classId: number
): Promise<SubmissionContext[]> {
  const { data: submissions, error } = await supabase
    .from("submissions")
    .select("id")
    .eq("profile_id", studentProfileId)
    .eq("assignment_id", assignmentId)
    .eq("class_id", classId)
    .order("created_at", { ascending: false });

  if (error || !submissions) return [];

  const results: SubmissionContext[] = [];
  for (const sub of submissions) {
    const submission = await getSubmission(supabase, sub.id, classId, true, true);
    if (submission) {
      results.push(submission);
    }
  }

  return results;
}

/**
 * Search help requests
 */
export async function searchHelpRequests(
  supabase: SupabaseClient,
  classId: number,
  options: {
    assignmentId?: number;
    status?: string;
    limit?: number;
  } = {}
): Promise<HelpRequestContext[]> {
  let query = supabase
    .from("help_requests")
    .select("id")
    .eq("class_id", classId)
    .order("created_at", { ascending: false })
    .limit(options.limit || 20);

  if (options.status) {
    query = query.eq("status", options.status);
  }

  const { data, error } = await query;

  if (error || !data) return [];

  // For now, just return basic results
  // If assignmentId filter is needed, we'd need to join through submissions
  const results: HelpRequestContext[] = [];
  for (const hr of data) {
    const helpRequest = await getHelpRequest(supabase, hr.id, classId);
    if (helpRequest) {
      // Filter by assignment if specified
      if (options.assignmentId) {
        if (helpRequest.assignment?.id === options.assignmentId) {
          results.push(helpRequest);
        }
      } else {
        results.push(helpRequest);
      }
    }
    // Stop if we've reached the limit
    if (results.length >= (options.limit || 20)) break;
  }

  return results;
}

/**
 * Escape and quote a search query for safe use in PostgREST filters
 * Escapes backslashes, double quotes, and SQL wildcard characters (% and _)
 */
function escapeSearchQuery(searchQuery: string): string {
  // First escape backslashes (must be done first since backslash is the escape character)
  let escaped = searchQuery.replace(/\\/g, "\\\\");
  // Escape double quotes
  escaped = escaped.replace(/"/g, '\\"');
  // Escape SQL wildcard characters (% and _) so they're treated as literals
  escaped = escaped.replace(/%/g, "\\%");
  escaped = escaped.replace(/_/g, "\\_");
  // Return escaped value (will be wrapped in quotes with wildcards in the filter string)
  return escaped;
}

/**
 * Search discussion threads
 */
export async function searchDiscussionThreads(
  supabase: SupabaseClient,
  classId: number,
  options: {
    assignmentId?: number;
    isQuestion?: boolean;
    searchQuery?: string;
    limit?: number;
  } = {}
): Promise<DiscussionThreadContext[]> {
  // If filtering by assignment, first get the topic IDs for that assignment
  let topicIds: number[] | null = null;
  if (options.assignmentId) {
    const { data: topics } = await supabase
      .from("discussion_topics")
      .select("id")
      .eq("class_id", classId)
      .eq("assignment_id", options.assignmentId);

    if (topics && topics.length > 0) {
      topicIds = topics.map((t) => t.id);
    } else {
      return []; // No topics found for this assignment
    }
  }

  let query = supabase
    .from("discussion_threads")
    .select("id")
    .eq("class_id", classId)
    .is("parent", null) // Only root threads
    .order("created_at", { ascending: false })
    .limit(options.limit || 20);

  if (topicIds) {
    query = query.in("topic_id", topicIds);
  }

  if (options.isQuestion !== undefined) {
    query = query.eq("is_question", options.isQuestion);
  }

  if (options.searchQuery) {
    const escapedQuery = escapeSearchQuery(options.searchQuery);
    // Wrap the pattern in quotes to prevent filter injection, with % wildcards for "contains" matching
    query = query.or(`subject.ilike."%${escapedQuery}%",body.ilike."%${escapedQuery}%"`);
  }

  const { data, error } = await query;

  if (error || !data) return [];

  const results: DiscussionThreadContext[] = [];
  for (const thread of data) {
    const threadContext = await getDiscussionThread(supabase, thread.id, classId, false);
    if (threadContext) {
      results.push(threadContext);
    }
  }

  return results;
}

/**
 * Normalize a template repository string to extract org and repo
 * Handles full URLs, missing org, extra segments, etc.
 * Returns [org, repo] or null if invalid
 */
function normalizeTemplateRepo(templateRepo: string | null): [string, string] | null {
  if (!templateRepo) return null;

  // Remove protocol and domain if present (e.g., https://github.com/org/repo -> org/repo)
  let normalized = templateRepo.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  normalized = normalized.replace(/^git@github\.com:/i, "");
  normalized = normalized.replace(/\.git$/, "");

  // Remove leading/trailing slashes
  normalized = normalized.trim().replace(/^\/+|\/+$/g, "");

  // Split by slash and filter out empty parts
  const parts = normalized.split("/").filter((p) => p.length > 0);

  // Must have exactly two parts (org and repo)
  if (parts.length !== 2) {
    return null;
  }

  return [parts[0], parts[1]];
}

const MAX_FILES = 100; // Maximum number of files to process
const FILE_FETCH_CONCURRENCY = 10; // Maximum concurrent file fetches

/**
 * Get handout files from the template repository
 */
export async function getHandoutFiles(
  supabase: SupabaseClient,
  assignmentId: number,
  classId: number
): Promise<HandoutFileContext[]> {
  // Get the assignment to find the template repo
  const { data: assignment, error } = await supabase
    .from("assignments")
    .select("template_repo")
    .eq("id", assignmentId)
    .eq("class_id", classId)
    .single();

  if (error || !assignment?.template_repo) {
    return [];
  }

  // Validate and normalize template_repo before destructuring
  const normalizedRepo = normalizeTemplateRepo(assignment.template_repo);
  if (!normalizedRepo) {
    return []; // Fail-fast if template_repo doesn't resolve to exactly two parts
  }

  const [org, repo] = normalizedRepo;

  try {
    // List all files in the template repo
    const allFiles = await github.listFilesInRepo(org, repo);

    // Cap the number of files processed
    const files = allFiles.slice(0, MAX_FILES);

    // Filter out common non-code files
    const excludePatterns = [
      /^\.git/,
      /^\.github\/workflows/,
      /node_modules/,
      /^\.DS_Store$/,
      /\.class$/,
      /\.pyc$/,
      /^__pycache__/
    ];

    // Filter files by excludePatterns and size before parallel processing
    const eligibleFiles = files.filter((file) => {
      // Skip excluded patterns
      if (excludePatterns.some((pattern) => pattern.test(file.path))) {
        return false;
      }
      // Skip large files (> 100KB)
      if (file.size > 100000) {
        return false;
      }
      return true;
    });

    // Process files in parallel with bounded concurrency using Promise.allSettled
    const templateRepo = `${org}/${repo}`;
    const codeFiles: HandoutFileContext[] = [];

    // Process files in batches with bounded concurrency
    for (let i = 0; i < eligibleFiles.length; i += FILE_FETCH_CONCURRENCY) {
      const batch = eligibleFiles.slice(i, i + FILE_FETCH_CONCURRENCY);
      const batchPromises = batch.map(async (file) => {
        try {
          const content = await github.getFileFromRepo(templateRepo, file.path);
          if (content && "content" in content) {
            return {
              path: file.path,
              content: content.content
            } as HandoutFileContext;
          }
          return null;
        } catch {
          // Skip files that can't be read (binary, etc.)
          return null;
        }
      });

      // Use Promise.allSettled to handle failures gracefully
      const batchResults = await Promise.allSettled(batchPromises);
      for (const result of batchResults) {
        if (result.status === "fulfilled" && result.value !== null) {
          codeFiles.push(result.value);
        }
      }
    }

    return codeFiles;
  } catch {
    return [];
  }
}

/**
 * Get instructor test files from the grader repository
 */
export async function getGraderFiles(
  supabase: SupabaseClient,
  assignmentId: number,
  classId: number
): Promise<GraderFileContext[]> {
  // Get the autograder info to find the grader repo
  const { data: autograder, error } = await supabase
    .from("autograder")
    .select("grader_repo")
    .eq("id", assignmentId)
    .single();

  if (error || !autograder?.grader_repo) {
    return [];
  }

  try {
    // List all files in the grader repo
    const [org, repo] = autograder.grader_repo.split("/");
    const files = await github.listFilesInRepo(org, repo);

    // Get content for each file
    const graderFiles: GraderFileContext[] = [];
    const excludePatterns = [/^\.git/, /node_modules/, /^\.DS_Store$/, /\.class$/, /\.pyc$/, /^__pycache__/];

    for (const file of files) {
      // Skip excluded patterns
      if (excludePatterns.some((pattern) => pattern.test(file.path))) {
        continue;
      }

      // Skip large files (> 100KB)
      if (file.size > 100000) {
        continue;
      }

      try {
        const content = await github.getFileFromRepo(autograder.grader_repo, file.path);
        if (content && "content" in content) {
          graderFiles.push({
            path: file.path,
            content: content.content
          });
        }
      } catch {
        // Skip files that can't be read
        continue;
      }
    }

    return graderFiles;
  } catch {
    return [];
  }
}
