/**
 * Pawtograder MCP Server
 *
 * This MCP server provides tools for AI assistants to help TAs support students
 * who are struggling with errors in their submissions.
 *
 * Access is restricted to instructors and graders only.
 * User privacy is protected - the "users" table and "is_private_profile" fields
 * are never exposed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserRole } from "./types.js";
import { requireClassAccess } from "./auth.js";
import {
  getAssignment,
  getHelpRequest,
  getDiscussionThread,
  getSubmission,
  getSubmissionsForStudent,
  searchHelpRequests,
  searchDiscussionThreads,
} from "./data.js";

// Input schemas for tools
const GetHelpRequestSchema = z.object({
  help_request_id: z.number().describe("The ID of the help request to fetch"),
  class_id: z.number().describe("The class ID where the help request exists"),
});

const GetDiscussionThreadSchema = z.object({
  thread_id: z.number().describe("The ID of the discussion thread to fetch"),
  class_id: z.number().describe("The class ID where the thread exists"),
  include_replies: z.boolean().optional().default(true).describe("Whether to include replies"),
});

const GetSubmissionSchema = z.object({
  submission_id: z.number().describe("The ID of the submission to fetch"),
  class_id: z.number().describe("The class ID where the submission exists"),
  include_test_output: z.boolean().optional().default(true).describe("Whether to include test output"),
});

const GetSubmissionsForStudentSchema = z.object({
  student_profile_id: z.string().describe("The profile ID of the student"),
  assignment_id: z.number().describe("The assignment ID to get submissions for"),
  class_id: z.number().describe("The class ID"),
});

const GetAssignmentSchema = z.object({
  assignment_id: z.number().describe("The ID of the assignment to fetch"),
  class_id: z.number().describe("The class ID where the assignment exists"),
});

const SearchHelpRequestsSchema = z.object({
  class_id: z.number().describe("The class ID to search in"),
  assignment_id: z.number().optional().describe("Filter by assignment ID"),
  status: z.string().optional().describe("Filter by status (pending, in_progress, resolved)"),
  limit: z.number().optional().default(20).describe("Maximum number of results"),
});

const SearchDiscussionThreadsSchema = z.object({
  class_id: z.number().describe("The class ID to search in"),
  assignment_id: z.number().optional().describe("Filter by assignment ID"),
  is_question: z.boolean().optional().describe("Filter to only questions"),
  search_query: z.string().optional().describe("Search query for subject/body"),
  limit: z.number().optional().default(20).describe("Maximum number of results"),
});

/**
 * Creates and configures the MCP server with all tools
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "pawtograder",
    version: "0.1.0",
  });

  // Register tools
  server.tool(
    "get_help_request",
    "Get a help request with full context including the student's question, linked assignment (with handout URL), submission details, and conversation messages. Use this to understand what a student is struggling with.",
    GetHelpRequestSchema.shape,
    async (args, extra) => {
      const { supabase, roles } = extra.context as { supabase: SupabaseClient; roles: UserRole[] };
      const input = GetHelpRequestSchema.parse(args);

      requireClassAccess(roles, input.class_id);

      const helpRequest = await getHelpRequest(supabase, input.help_request_id, input.class_id);

      if (!helpRequest) {
        return {
          content: [{ type: "text", text: "Help request not found" }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(helpRequest, null, 2) }],
      };
    }
  );

  server.tool(
    "get_discussion_thread",
    "Get a discussion thread with full context including the question, assignment (with handout URL), and replies. Use this to understand student questions and existing answers.",
    GetDiscussionThreadSchema.shape,
    async (args, extra) => {
      const { supabase, roles } = extra.context as { supabase: SupabaseClient; roles: UserRole[] };
      const input = GetDiscussionThreadSchema.parse(args);

      requireClassAccess(roles, input.class_id);

      const thread = await getDiscussionThread(
        supabase,
        input.thread_id,
        input.class_id,
        input.include_replies
      );

      if (!thread) {
        return {
          content: [{ type: "text", text: "Discussion thread not found" }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(thread, null, 2) }],
      };
    }
  );

  server.tool(
    "get_submission",
    "Get a submission with full grader results including test outputs, build output, lint results, and error information. Use this to understand what errors a student is encountering.",
    GetSubmissionSchema.shape,
    async (args, extra) => {
      const { supabase, roles } = extra.context as { supabase: SupabaseClient; roles: UserRole[] };
      const input = GetSubmissionSchema.parse(args);

      requireClassAccess(roles, input.class_id);

      const submission = await getSubmission(
        supabase,
        input.submission_id,
        input.class_id,
        input.include_test_output
      );

      if (!submission) {
        return {
          content: [{ type: "text", text: "Submission not found" }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(submission, null, 2) }],
      };
    }
  );

  server.tool(
    "get_submissions_for_student",
    "Get all submissions for a student on a specific assignment. Use this to see the student's submission history and track their progress.",
    GetSubmissionsForStudentSchema.shape,
    async (args, extra) => {
      const { supabase, roles } = extra.context as { supabase: SupabaseClient; roles: UserRole[] };
      const input = GetSubmissionsForStudentSchema.parse(args);

      requireClassAccess(roles, input.class_id);

      const submissions = await getSubmissionsForStudent(
        supabase,
        input.student_profile_id,
        input.assignment_id,
        input.class_id
      );

      return {
        content: [{ type: "text", text: JSON.stringify(submissions, null, 2) }],
      };
    }
  );

  server.tool(
    "get_assignment",
    "Get assignment details including title, description, handout URL, due date, and points. The handout URL provides a link to the assignment instructions.",
    GetAssignmentSchema.shape,
    async (args, extra) => {
      const { supabase, roles } = extra.context as { supabase: SupabaseClient; roles: UserRole[] };
      const input = GetAssignmentSchema.parse(args);

      requireClassAccess(roles, input.class_id);

      const assignment = await getAssignment(supabase, input.assignment_id, input.class_id);

      if (!assignment) {
        return {
          content: [{ type: "text", text: "Assignment not found" }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(assignment, null, 2) }],
      };
    }
  );

  server.tool(
    "search_help_requests",
    "Search help requests in a class, optionally filtered by assignment or status. Use this to find students who need help with similar issues.",
    SearchHelpRequestsSchema.shape,
    async (args, extra) => {
      const { supabase, roles } = extra.context as { supabase: SupabaseClient; roles: UserRole[] };
      const input = SearchHelpRequestsSchema.parse(args);

      requireClassAccess(roles, input.class_id);

      const helpRequests = await searchHelpRequests(supabase, input.class_id, {
        assignmentId: input.assignment_id,
        status: input.status,
        limit: input.limit,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(helpRequests, null, 2) }],
      };
    }
  );

  server.tool(
    "search_discussion_threads",
    "Search discussion threads in a class, optionally filtered by assignment, question status, or search query. Use this to find related discussions and existing answers.",
    SearchDiscussionThreadsSchema.shape,
    async (args, extra) => {
      const { supabase, roles } = extra.context as { supabase: SupabaseClient; roles: UserRole[] };
      const input = SearchDiscussionThreadsSchema.parse(args);

      requireClassAccess(roles, input.class_id);

      const threads = await searchDiscussionThreads(supabase, input.class_id, {
        assignmentId: input.assignment_id,
        isQuestion: input.is_question,
        searchQuery: input.search_query,
        limit: input.limit,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(threads, null, 2) }],
      };
    }
  );

  return server;
}
