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
    .select("id, name, avatar_url, class_id")
    .eq("id", profileId)
    .single();

  if (error || !data) return null;

  // Note: We deliberately do not include is_private_profile in the select
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
    for (const msg of messagesData) {
      const authorName = await getProfileName(supabase, msg.profile_id);

      // Check if the message author is staff
      const { data: roleData } = await supabase
        .from("user_roles")
        .select("role")
        .eq("private_profile_id", msg.profile_id)
        .eq("class_id", classId)
        .in("role", ["instructor", "grader"])
        .maybeSingle();

      messages.push({
        id: msg.id,
        content: msg.content,
        created_at: msg.created_at,
        author_name: authorName,
        is_staff: !!roleData
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
      for (const reply of repliesData) {
        const replyAuthorName = await getProfileName(supabase, reply.author);

        // Check if reply author is staff
        const { data: roleData } = await supabase
          .from("user_roles")
          .select("role")
          .eq("private_profile_id", reply.author)
          .eq("class_id", classId)
          .in("role", ["instructor", "grader"])
          .maybeSingle();

        replies.push({
          id: reply.id,
          body: reply.body,
          created_at: reply.created_at,
          author_name: replyAuthorName,
          is_staff: !!roleData,
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
    query = query.or(`subject.ilike.%${options.searchQuery}%,body.ilike.%${options.searchQuery}%`);
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

  try {
    // List all files in the template repo
    const [org, repo] = assignment.template_repo.split("/");
    const files = await github.listFilesInRepo(org, repo);

    // Filter out common non-code files and get content for each file
    const codeFiles: HandoutFileContext[] = [];
    const excludePatterns = [
      /^\.git/,
      /^\.github\/workflows/,
      /node_modules/,
      /^\.DS_Store$/,
      /\.class$/,
      /\.pyc$/,
      /^__pycache__/
    ];

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
        const content = await github.getFileFromRepo(assignment.template_repo, file.path);
        if (content && "content" in content) {
          codeFiles.push({
            path: file.path,
            content: content.content
          });
        }
      } catch {
        // Skip files that can't be read (binary, etc.)
        continue;
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
