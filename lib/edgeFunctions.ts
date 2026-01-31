import { ListReposResponse } from "@/components/github/GitHubTypes";
import * as FunctionTypes from "@/supabase/functions/_shared/FunctionTypes.js";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { CreateAttendeeCommandOutput, CreateMeetingCommandOutput } from "@aws-sdk/client-chime-sdk-meetings";
import { Endpoints } from "@octokit/types";
import { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
export async function autograderCreateReposForStudent(supabase: SupabaseClient<Database>, assignmentId?: number) {
  const { data } = await supabase.functions.invoke("autograder-create-repos-for-student", {
    body: {
      assignment_id: assignmentId
    }
  });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new Error(error.message + ": " + error.details);
  }
}

export async function autograderSyncAllPermissionsForStudent(supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("autograder-create-repos-for-student", {
    body: {
      sync_all_permissions: true
    }
  });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new Error(error.message + ": " + error.details);
  }
}
export async function autograderCreateAssignmentRepos(
  params: FunctionTypes.AssignmentCreateAllReposRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("assignment-create-all-repos", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { message: string };
}
export async function liveMeetingForHelpRequest(
  params: FunctionTypes.LiveMeetingForHelpRequestRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("live-meeting-for-help-request", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { Meeting: CreateMeetingCommandOutput; Attendee: CreateAttendeeCommandOutput };
}

export async function liveMeetingEnd(params: FunctionTypes.LiveMeetingEndRequest, supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("live-meeting-end", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { message: string };
}

export async function repositoriesForClass(
  params: FunctionTypes.ListReposRequest,
  supabase: SupabaseClient<Database>
): Promise<ListReposResponse> {
  const { data } = await supabase.functions.invoke("repositories-list", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as ListReposResponse;
}

export async function repositoryListFiles(params: FunctionTypes.ListFilesRequest, supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("repository-list-files", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as FunctionTypes.FileListing[];
}
export async function repositoryGetFile(params: FunctionTypes.GetFileRequest, supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("repository-get-file", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { content: string };
}
export async function githubRepoConfigureWebhook(
  params: FunctionTypes.GithubRepoConfigureWebhookRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("github-repo-configure-webhook", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { message: string };
}
export async function enrollmentAdd(params: FunctionTypes.AddEnrollmentRequest, supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("enrollments-add", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
}
export async function enrollmentSyncCanvas(params: { course_id: number }, supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("enrollments-sync-canvas", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { message: string };
}
export async function assignmentGroupLeave(params: { assignment_id: number }, supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("assignment-group-leave", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { message: string };
}
export async function assignmentGroupApproveRequest(
  params: { join_request_id: number; course_id: number },
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("assignment-group-approve-request", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { message: string };
}
export async function assignmentGroupCreate(
  params: FunctionTypes.AssignmentGroupCreateRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("assignment-group-create", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
}
export async function autograderSyncStaffTeam(params: { course_id: number }, supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("autograder-sync-staff-team", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as unknown;
}
export async function assignmentGroupJoin(
  params: FunctionTypes.AssignmentGroupJoinRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("assignment-group-join", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { message: string; joined_group: boolean };
}
export async function assignmentGroupCopyGroupsFromAssignment(
  params: FunctionTypes.AssignmentGroupCopyGroupsFromAssignmentRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("assignment-group-copy-groups-from-assignment", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as unknown;
}
export async function assignmentGroupInstructorMoveStudent(
  params: FunctionTypes.AssignmentGroupInstructorMoveStudentRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("assignment-group-instructor-move-student", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as unknown;
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
  const { data } = await supabase.functions.invoke("repository-list-commits", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { commits: ListCommitsResponse["data"]; has_more: boolean };
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
  const { data } = await supabase.functions.invoke("autograder-trigger-grading-workflow", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { message: string };
}
export async function assignmentGroupInstructorCreateGroup(
  params: FunctionTypes.AssignmentGroupInstructorCreateRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("assignment-group-instructor-create", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { message: string; id: number };
}

export async function assignmentCreateHandoutRepo(
  params: FunctionTypes.AssignmentCreateHandoutRepoRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("assignment-create-handout-repo", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as FunctionTypes.AssignmentCreateHandoutRepoResponse;
}

export async function assignmentCreateSolutionRepo(
  params: FunctionTypes.AssignmentCreateSolutionRepoRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("assignment-create-solution-repo", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as FunctionTypes.AssignmentCreateSolutionRepoResponse;
}
export async function resendOrgInvitation(
  params: { course_id: number; user_id: string },
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("autograder-reinvite-to-class-org", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
}
export async function assignmentDelete(
  params: FunctionTypes.AssignmentDeleteRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("assignment-delete", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as FunctionTypes.AssignmentDeleteResponse;
}

export async function courseImportSis(params: FunctionTypes.CourseImportRequest, supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("course-import-sis", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as FunctionTypes.CourseImportResponse;
}

export async function invitationCreate(
  params: FunctionTypes.CreateInvitationRequest,
  supabase: SupabaseClient<Database>
) {
  const { data } = await supabase.functions.invoke("invitation-create", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as FunctionTypes.CreateInvitationResponse;
}

export async function userFetchAzureProfile(params: { accessToken: string }, supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("user-fetch-azure-profile", { body: params });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
}
export async function syncGitHubAccount(supabase: SupabaseClient<Database>) {
  const { data } = await supabase.functions.invoke("github-user-sync", { body: {} });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { message: string };
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
  const { data } = await supabase.functions.invoke("mcp-tokens", {
    method: "GET"
  });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { tokens: MCPToken[] };
}

/**
 * Create a new MCP token
 */
export async function mcpTokensCreate(
  params: MCPTokenCreateRequest,
  supabase: SupabaseClient<Database>
): Promise<MCPTokenCreateResponse> {
  const { data } = await supabase.functions.invoke("mcp-tokens", {
    body: params
  });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as MCPTokenCreateResponse;
}

/**
 * Revoke an MCP token
 */
export async function mcpTokensRevoke(
  params: { token_id: string },
  supabase: SupabaseClient<Database>
): Promise<{ success: boolean; message: string }> {
  const { data } = await supabase.functions.invoke("mcp-tokens", {
    method: "DELETE",
    body: params
  });
  const { error } = data as FunctionTypes.GenericResponse;
  if (error) {
    throw new EdgeFunctionError(error);
  }
  return data as { success: boolean; message: string };
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
