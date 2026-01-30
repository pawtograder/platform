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
  hasScope,
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

async function getProfileName(supabase: SupabaseClient<Database>, profileId: string | null): Promise<string | null> {
  if (!profileId) return null;

  const { data, error } = await supabase.from("profiles").select("name").eq("id", profileId).single();

  if (error || !data) return null;
  return data.name;
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

async function getSubmissionFiles(supabase: SupabaseClient<Database>, submissionId: number, classId: number) {
  const { data, error } = await supabase
    .from("submission_files")
    .select("id, name, contents")
    .eq("submission_id", submissionId)
    .eq("class_id", classId)
    .order("name", { ascending: true });

  if (error || !data) return [];
  return data;
}

async function getSubmission(
  supabase: SupabaseClient<Database>,
  submissionId: number,
  classId: number,
  includeTestOutput = true,
  includeFiles = true
) {
  const { data: submission, error: subError } = await supabase
    .from("submissions")
    .select("id, assignment_id, created_at, sha, repository, ordinal, is_active, profile_id")
    .eq("id", submissionId)
    .eq("class_id", classId)
    .single();

  if (subError || !submission) return null;

  const studentName = await getProfileName(supabase, submission.profile_id);

  // Get grader result
  const { data: graderData } = await supabase
    .from("grader_results")
    .select("id, score, max_score, lint_passed, lint_output, lint_output_format, errors, execution_time, ret_code")
    .eq("submission_id", submissionId)
    .eq("class_id", classId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let graderResult = null;
  if (graderData) {
    // Get test results
    const { data: testsData } = await supabase
      .from("grader_result_tests")
      .select("id, name, part, score, max_score, output, output_format, is_released")
      .eq("grader_result_id", graderData.id)
      .order("id", { ascending: true });

    const tests = (testsData || []).map((test) => ({
      id: test.id,
      name: test.name,
      part: test.part,
      score: test.score,
      max_score: test.max_score,
      output: includeTestOutput ? test.output : null,
      output_format: test.output_format,
      is_released: test.is_released
    }));

    // Get build output
    const { data: outputData } = await supabase
      .from("grader_result_output")
      .select("stdout, stderr, combined_output, output_format")
      .eq("grader_result_id", graderData.id)
      .maybeSingle();

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
      build_output: outputData || null
    };
  }

  // Get submission files
  let files = null;
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

  const studentName = await getProfileName(supabase, helpRequest.created_by);
  const helpQueueName = (helpRequest.help_queues as unknown as { name: string })?.name || "Unknown Queue";

  // Get linked submission
  let submission = null;
  if (helpRequest.referenced_submission_id) {
    submission = await getSubmission(supabase, helpRequest.referenced_submission_id, classId, true, true);
  }

  // Get assignment
  let assignment = null;
  if (submission) {
    assignment = await getAssignment(supabase, submission.assignment_id, classId);
  }

  // Get latest submission for the student
  let latestSubmission = null;
  if (assignment && helpRequest.created_by) {
    latestSubmission = await getLatestSubmissionForStudent(
      supabase,
      helpRequest.created_by,
      assignment.id,
      classId,
      true
    );
    if (latestSubmission && submission && latestSubmission.id === submission.id) {
      latestSubmission = null;
    }
  }

  // Get messages
  const { data: messagesData } = await supabase
    .from("help_requests_messages")
    .select("id, content, created_at, profile_id")
    .eq("help_request_id", helpRequestId)
    .order("created_at", { ascending: true });

  const messages = [];
  if (messagesData) {
    for (const msg of messagesData) {
      const authorName = await getProfileName(supabase, msg.profile_id);
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

async function getDiscussionThread(
  supabase: SupabaseClient<Database>,
  threadId: number,
  classId: number,
  includeReplies = true
) {
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

  const authorName = await getProfileName(supabase, thread.author);

  // Get assignment
  let assignment = null;
  const topic = thread.discussion_topics as unknown as { assignment_id: number | null };
  if (topic?.assignment_id) {
    assignment = await getAssignment(supabase, topic.assignment_id, classId);
  }

  // Get latest submission for author
  let latestSubmission = null;
  if (assignment && thread.author) {
    latestSubmission = await getLatestSubmissionForStudent(supabase, thread.author, assignment.id, classId, true);
  }

  // Get replies
  const replies = [];
  if (includeReplies && thread.children_count > 0) {
    const { data: repliesData } = await supabase
      .from("discussion_threads")
      .select("id, body, created_at, author")
      .eq("root", threadId)
      .eq("class_id", classId)
      .order("created_at", { ascending: true })
      .limit(50);

    if (repliesData) {
      for (const reply of repliesData) {
        const replyAuthorName = await getProfileName(supabase, reply.author);
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

async function searchHelpRequests(
  supabase: SupabaseClient<Database>,
  classId: number,
  options: { assignmentId?: number; status?: string; limit?: number } = {}
) {
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

  const results = [];
  for (const hr of data) {
    const helpRequest = await getHelpRequest(supabase, hr.id, classId);
    if (helpRequest) {
      if (options.assignmentId) {
        if (helpRequest.assignment?.id === options.assignmentId) {
          results.push(helpRequest);
        }
      } else {
        results.push(helpRequest);
      }
    }
    if (results.length >= (options.limit || 20)) break;
  }

  return results;
}

async function searchDiscussionThreads(
  supabase: SupabaseClient<Database>,
  classId: number,
  options: { assignmentId?: number; isQuestion?: boolean; searchQuery?: string; limit?: number } = {}
) {
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
      return [];
    }
  }

  let query = supabase
    .from("discussion_threads")
    .select("id")
    .eq("class_id", classId)
    .is("parent", null)
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

  const results = [];
  for (const thread of data) {
    const threadContext = await getDiscussionThread(supabase, thread.id, classId, false);
    if (threadContext) {
      results.push(threadContext);
    }
  }

  return results;
}

async function getSubmissionsForStudent(
  supabase: SupabaseClient<Database>,
  studentProfileId: string,
  assignmentId: number,
  classId: number
) {
  const { data: submissions, error } = await supabase
    .from("submissions")
    .select("id")
    .eq("profile_id", studentProfileId)
    .eq("assignment_id", assignmentId)
    .eq("class_id", classId)
    .order("created_at", { ascending: false });

  if (error || !submissions) return [];

  const results = [];
  for (const sub of submissions) {
    const submission = await getSubmission(supabase, sub.id, classId, true, true);
    if (submission) {
      results.push(submission);
    }
  }

  return results;
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
    console.error("MCP request error:", error);
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
    console.error("Request error:", error);
    Sentry.captureException(error);

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
