import { ListReposResponse } from "@/components/github/GitHubTypes";
import * as FunctionTypes from "@/supabase/functions/_shared/FunctionTypes.js";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { CreateAttendeeCommandOutput, CreateMeetingCommandOutput } from "@aws-sdk/client-chime-sdk-meetings";
import { Endpoints } from "@octokit/types";
import { SupabaseClient } from "@supabase/supabase-js";
import type { FunctionInvokeOptions } from "@supabase/functions-js";
import * as Sentry from "@sentry/nextjs";

/** Invokes autograder-create-repos-for-student. Use `opts.forTestAssignment` only from the instructor Test Assignment UI. */
export async function autograderCreateReposForStudent(
  supabase: SupabaseClient<Database>,
  assignmentId?: number,
  opts?: { forTestAssignment?: boolean }
) {
  await invokeEdgeFunction(supabase, "autograder-create-repos-for-student", {
    body: {
      assignment_id: assignmentId,
      ...(opts?.forTestAssignment && assignmentId !== undefined ? { for_test_assignment: true } : {})
    }
  });
}

export async function autograderSyncAllPermissionsForStudent(supabase: SupabaseClient<Database>) {
  await invokeEdgeFunction(supabase, "autograder-create-repos-for-student", {
    body: {
      sync_all_permissions: true
    }
  });
}
export async function autograderCreateAssignmentRepos(
  params: FunctionTypes.AssignmentCreateAllReposRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ message: string }>(supabase, "assignment-create-all-repos", { body: params });
}
export async function liveMeetingForHelpRequest(
  params: FunctionTypes.LiveMeetingForHelpRequestRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ Meeting: CreateMeetingCommandOutput; Attendee: CreateAttendeeCommandOutput }>(supabase, "live-meeting-for-help-request", { body: params });
}

export async function liveMeetingEnd(params: FunctionTypes.LiveMeetingEndRequest, supabase: SupabaseClient<Database>) {
  return await invokeEdgeFunction<{ message: string }>(supabase, "live-meeting-end", { body: params });
}

export async function repositoriesForClass(
  params: FunctionTypes.ListReposRequest,
  supabase: SupabaseClient<Database>
): Promise<ListReposResponse> {
  return await invokeEdgeFunction<ListReposResponse>(supabase, "repositories-list", { body: params });
}

export async function repositoryListFiles(params: FunctionTypes.ListFilesRequest, supabase: SupabaseClient<Database>) {
  return await invokeEdgeFunction<FunctionTypes.FileListing[]>(supabase, "repository-list-files", { body: params });
}
export async function repositoryGetFile(params: FunctionTypes.GetFileRequest, supabase: SupabaseClient<Database>) {
  return await invokeEdgeFunction<{ content: string }>(supabase, "repository-get-file", { body: params });
}
export async function githubRepoConfigureWebhook(
  params: FunctionTypes.GithubRepoConfigureWebhookRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ message: string }>(supabase, "github-repo-configure-webhook", { body: params });
}
export async function enrollmentAdd(params: FunctionTypes.AddEnrollmentRequest, supabase: SupabaseClient<Database>) {
  await invokeEdgeFunction(supabase, "enrollments-add", { body: params });
}
export async function enrollmentSyncCanvas(params: { course_id: number }, supabase: SupabaseClient<Database>) {
  return await invokeEdgeFunction<{ message: string }>(supabase, "enrollments-sync-canvas", { body: params });
}
export async function assignmentGroupLeave(params: { assignment_id: number }, supabase: SupabaseClient<Database>) {
  return await invokeEdgeFunction<{ message: string }>(supabase, "assignment-group-leave", { body: params });
}
export async function assignmentGroupApproveRequest(
  params: { join_request_id: number; course_id: number },
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ message: string }>(supabase, "assignment-group-approve-request", { body: params });
}
export async function assignmentGroupCreate(
  params: FunctionTypes.AssignmentGroupCreateRequest,
  supabase: SupabaseClient<Database>
) {
  await invokeEdgeFunction(supabase, "assignment-group-create", { body: params });
}
export async function autograderSyncStaffTeam(params: { course_id: number }, supabase: SupabaseClient<Database>) {
  return await invokeEdgeFunction(supabase, "autograder-sync-staff-team", { body: params });
}
export async function assignmentGroupJoin(
  params: FunctionTypes.AssignmentGroupJoinRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ message: string; joined_group: boolean }>(supabase, "assignment-group-join", { body: params });
}
export async function assignmentGroupCopyGroupsFromAssignment(
  params: FunctionTypes.AssignmentGroupCopyGroupsFromAssignmentRequest,
  supabase: SupabaseClient<Database>
) {
  const { data, error } = await (supabase.rpc as CallableFunction)("copy_groups_from_assignment", {
    p_class_id: params.class_id,
    p_source_assignment_id: params.source_assignment_id,
    p_target_assignment_id: params.target_assignment_id
  });
  if (error) {
    throw new EdgeFunctionError({
      details: error.message,
      message: error.message,
      recoverable: false
    });
  }
  return data as unknown;
}
export async function assignmentGroupInstructorMoveStudent(
  params: FunctionTypes.AssignmentGroupInstructorMoveStudentRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction(supabase, "assignment-group-instructor-move-student", { body: params });
}
export async function activateSubmission(params: { submission_id: number }, supabase: SupabaseClient<Database>) {
  const ret = await supabase.rpc("submission_set_active", { _submission_id: params.submission_id });
  if (ret.data) {
    return true;
  }
  Sentry.addBreadcrumb({
    message: "Failed to activate submission",
    category: "error",
    data: {
      submission_id: params.submission_id,
      response: ret
    }
  });
  throw new EdgeFunctionError({
    details: "Failed to activate submission",
    message: "Failed to activate submission",
    recoverable: false
  });
}
export type ListCommitsResponse = Endpoints["GET /repos/{owner}/{repo}/commits"]["response"];
export async function repositoryListCommits(
  params: FunctionTypes.RepositoryListCommitsRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ commits: ListCommitsResponse["data"]; has_more: boolean }>(supabase, "repository-list-commits", { body: params });
}

export async function rerunGrader(
  params: FunctionTypes.AutograderRerunGraderRequest,
  supabase: SupabaseClient<Database>
) {
  // Call the new RPC function instead of the edge function
  // The function uses auth.uid() internally to get the current user
  const { data, error } = await supabase.rpc("enqueue_autograder_reruns", {
    p_submission_ids: params.submission_ids,
    p_class_id: params.class_id,
    p_grader_sha: params.grader_sha ?? undefined,
    p_auto_promote: params.auto_promote ?? true
  });

  if (error) {
    throw new EdgeFunctionError({
      details: error.message,
      message: error.message,
      recoverable: false
    });
  }

  return data as {
    enqueued_count: number;
    failed_count: number;
    skipped_count: number;
    failed_submissions: unknown[];
    skipped_submissions: unknown[];
    total_requested: number;
  };
}
export async function triggerWorkflow(
  params: FunctionTypes.AutograderTriggerGradingWorkflowRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ message: string }>(supabase, "autograder-trigger-grading-workflow", { body: params });
}
export async function assignmentGroupInstructorCreateGroup(
  params: FunctionTypes.AssignmentGroupInstructorCreateRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ message: string; id: number }>(supabase, "assignment-group-instructor-create", { body: params });
}

export async function assignmentCreateHandoutRepo(
  params: FunctionTypes.AssignmentCreateHandoutRepoRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.AssignmentCreateHandoutRepoResponse>(supabase, "assignment-create-handout-repo", { body: params });
}

export async function assignmentCreateSolutionRepo(
  params: FunctionTypes.AssignmentCreateSolutionRepoRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.AssignmentCreateSolutionRepoResponse>(supabase, "assignment-create-solution-repo", { body: params });
}
export async function resendOrgInvitation(
  params: { course_id: number; user_id: string },
  supabase: SupabaseClient<Database>
) {
  await invokeEdgeFunction(supabase, "autograder-reinvite-to-class-org", { body: params });
}
export async function assignmentDelete(
  params: FunctionTypes.AssignmentDeleteRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.AssignmentDeleteResponse>(supabase, "assignment-delete", { body: params });
}

export async function courseImportSis(params: FunctionTypes.CourseImportRequest, supabase: SupabaseClient<Database>) {
  return await invokeEdgeFunction<FunctionTypes.CourseImportResponse>(supabase, "course-import-sis", { body: params });
}

export async function invitationCreate(
  params: FunctionTypes.CreateInvitationRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.CreateInvitationResponse>(supabase, "invitation-create", { body: params });
}

export async function userFetchAzureProfile(params: { accessToken: string }, supabase: SupabaseClient<Database>) {
  await invokeEdgeFunction(supabase, "user-fetch-azure-profile", { body: params });
}
export async function syncGitHubAccount(supabase: SupabaseClient<Database>) {
  return await invokeEdgeFunction<{ message: string }>(supabase, "github-user-sync", { body: {} });
}
export class EdgeFunctionError extends Error {
  details: string;
  recoverable: boolean;

  constructor({ details, message, recoverable }: { details: string; message: string; recoverable: boolean }) {
    super(message);
    this.details = details;
    this.recoverable = recoverable;
  }
}

/**
 * Invoke a Supabase Edge Function and handle errors from both non-2xx responses
 * (where the SDK returns { data: null, error: FunctionsHttpError }) and 2xx responses
 * that contain an error in the body (legacy pattern).
 */
async function invokeEdgeFunction<T = unknown>(
  supabase: SupabaseClient<Database>,
  functionName: string,
  options?: FunctionInvokeOptions
): Promise<T> {
  const { data, error } = await supabase.functions.invoke(functionName, options);
  if (error) {
    // Non-2xx response — try to extract structured error from the response body
    if (error.context instanceof Response) {
      try {
        const body = await error.context.json();
        if (body?.error) {
          throw new EdgeFunctionError(body.error);
        }
      } catch (e) {
        if (e instanceof EdgeFunctionError) throw e;
        // Response body wasn't JSON or didn't contain error — fall through
      }
    }
    throw new EdgeFunctionError({
      message: error.message,
      details: error.message,
      recoverable: false
    });
  }
  // 2xx response — check for error in body (legacy pattern, shouldn't happen with status code fix)
  const response = data as FunctionTypes.GenericResponse;
  if (response?.error) {
    throw new EdgeFunctionError(response.error);
  }
  return data as T;
}

// MCP Token types
export type MCPScope = "mcp:read" | "mcp:write";

export interface MCPToken {
  id: string;
  token_id: string;
  name: string;
  scopes: MCPScope[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface MCPTokenCreateRequest {
  name: string;
  scopes?: MCPScope[];
  expires_in_days?: number;
}

export interface MCPTokenCreateResponse {
  token: string;
  metadata: MCPToken;
  message: string;
}

/**
 * List all MCP tokens for the current user
 */
export async function mcpTokensList(supabase: SupabaseClient<Database>): Promise<{ tokens: MCPToken[] }> {
  return await invokeEdgeFunction<{ tokens: MCPToken[] }>(supabase, "mcp-tokens", { method: "GET" });
}

/**
 * Create a new MCP token
 */
export async function mcpTokensCreate(
  params: MCPTokenCreateRequest,
  supabase: SupabaseClient<Database>
): Promise<MCPTokenCreateResponse> {
  return await invokeEdgeFunction<MCPTokenCreateResponse>(supabase, "mcp-tokens", { body: params });
}

/**
 * Revoke an MCP token
 */
export async function mcpTokensRevoke(
  params: { token_id: string },
  supabase: SupabaseClient<Database>
): Promise<{ success: boolean; message: string }> {
  return await invokeEdgeFunction<{ success: boolean; message: string }>(supabase, "mcp-tokens", { method: "DELETE", body: params });
}

// AI Help Feedback types
export type AIHelpContextType = "help_request" | "discussion_thread" | "test_failure" | "build_error" | "test_insights";

export interface AIHelpFeedbackRequest {
  class_id: number;
  context_type: AIHelpContextType;
  resource_id: number;
  rating: "thumbs_up" | "thumbs_down";
  comment?: string;
}

export interface AIHelpFeedbackResponse {
  success: boolean;
  feedback_id: string;
  message: string;
  error?: string;
}

/**
 * Submit AI help feedback via RPC
 */
export async function aiHelpFeedbackSubmit(
  params: AIHelpFeedbackRequest,
  supabase: SupabaseClient<Database>
): Promise<AIHelpFeedbackResponse> {
  // Use type assertion since the RPC function may not be in generated types yet
  const { data, error } = await (supabase.rpc as CallableFunction)("submit_ai_help_feedback", {
    p_class_id: params.class_id,
    p_context_type: params.context_type,
    p_resource_id: params.resource_id,
    p_rating: params.rating,
    p_comment: params.comment ?? null
  });

  if (error) {
    throw new EdgeFunctionError({
      details: error.message,
      message: error.message,
      recoverable: false
    });
  }

  const result = data as unknown as AIHelpFeedbackResponse;
  if (result.error) {
    throw new EdgeFunctionError({
      details: result.error,
      message: result.error,
      recoverable: false
    });
  }

  return result;
}
