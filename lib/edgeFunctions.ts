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

/**
 * Demo-only: create a single per-student assignment repo, optionally seeding it from a
 * canned submission template instead of the assignment's empty handout. The edge function
 * enforces that `template_repo_override` only works under edge-secret or service-role auth,
 * so `supabase` here must be a service-role admin client.
 */
export async function autograderCreateRepoForStudentDemo(
  params: FunctionTypes.AutograderCreateReposForStudentRequest,
  supabase: SupabaseClient<Database>
) {
  await invokeEdgeFunction(supabase, "autograder-create-repos-for-student", { body: params });
}
export async function autograderCreateAssignmentRepos(
  params: FunctionTypes.AssignmentCreateAllReposRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ message: string }>(supabase, "assignment-create-all-repos", { body: params });
}
/** (Re)build the code-symbol index for a submission's source files (used by reindex tooling). */
export async function indexSubmission(
  params: FunctionTypes.IndexSubmissionRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.IndexSubmissionResponse>(supabase, "index-submission", {
    body: params
  });
}
export async function liveMeetingForHelpRequest(
  params: FunctionTypes.LiveMeetingForHelpRequestRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ Meeting: CreateMeetingCommandOutput; Attendee: CreateAttendeeCommandOutput }>(
    supabase,
    "live-meeting-for-help-request",
    { body: params }
  );
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
  return await invokeEdgeFunction<{ message: string; joined_group: boolean }>(supabase, "assignment-group-join", {
    body: params
  });
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
export type NoRepoSubmissionFile = {
  /** Display name (e.g. "presentation.pdf"). */
  name: string;
  /** Full path within the `submission-files` bucket. */
  storage_key: string;
  file_size: number;
  mime_type: string | null;
};

/**
 * Create a submission for an assignment with repo_mode='none'. The caller must
 * upload each file to the `submission-files` storage bucket first; this RPC
 * just inserts the submission row + the submission_files records referencing
 * the storage keys. Returns the new submission id.
 */
export async function createNoRepoSubmission(
  params: { assignment_id: number; files: NoRepoSubmissionFile[] },
  supabase: SupabaseClient<Database>
): Promise<number> {
  const { data, error } = await (supabase.rpc as CallableFunction)("create_no_repo_submission", {
    p_assignment_id: params.assignment_id,
    p_files: params.files
  });
  if (error) {
    Sentry.captureException(error);
    throw new EdgeFunctionError({
      details: error.message,
      message: "Failed to create no-repo submission",
      recoverable: false
    });
  }
  if (typeof data !== "number" || !Number.isFinite(data)) {
    throw new EdgeFunctionError({
      details: `Unexpected RPC result: ${JSON.stringify(data)}`,
      message: "Failed to create no-repo submission",
      recoverable: false
    });
  }
  return data;
}

/**
 * A file row to register against an upload submission: either inline text
 * (`contents` + `is_binary:false`, rendered by the existing file viewer like a
 * git text file) or a binary object already uploaded to storage (`storage_key`
 * + `is_binary:true`, under the submission-id-scoped prefix so its read RLS
 * applies).
 */
export type AttachSubmissionFile = {
  name: string;
  file_size: number;
  mime_type: string | null;
  is_binary: boolean;
  storage_key?: string | null;
  contents?: string | null;
};

/**
 * Phase two of the no-repo upload flow: register the uploaded files against an
 * already-created `upload` submission.
 */
export async function attachNoRepoSubmissionFiles(
  params: { submission_id: number; files: AttachSubmissionFile[] },
  supabase: SupabaseClient<Database>
): Promise<void> {
  const { error } = await supabase.rpc("attach_no_repo_submission_files", {
    p_submission_id: params.submission_id,
    p_files: params.files
  });
  if (error) {
    Sentry.captureException(error);
    throw new EdgeFunctionError({
      details: error.message,
      message: "Failed to attach uploaded files to submission",
      recoverable: false
    });
  }
}

/** A file the student picked in the browser, plus its target storage path. */
export type PendingUploadFile = { name: string; file: Blob; size: number; mimeType: string | null };

// Text files (markdown, source, etc.) are stored inline so the existing file
// viewer renders them. Anything larger than this, or not recognized as text,
// is stored as a binary object in the submission-files bucket instead.
const INLINE_TEXT_MAX_BYTES = 1024 * 1024;
const INLINE_TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "mdown",
  "mkdn",
  "mkd",
  "txt",
  "text",
  "rst",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cs",
  "go",
  "rb",
  "rs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "r",
  "kt",
  "swift",
  "scala",
  "pl",
  "lua",
  "ini",
  "cfg",
  "conf",
  "env",
  "gitignore",
  "dockerfile",
  "makefile",
  "log",
  "tex"
]);

/** Whether a picked file should be stored inline as text rather than as a binary blob. */
function isInlineTextUpload(name: string, mimeType: string | null, size: number): boolean {
  if (size > INLINE_TEXT_MAX_BYTES) return false;
  if (
    mimeType &&
    (mimeType.startsWith("text/") ||
      mimeType === "application/json" ||
      mimeType === "application/xml" ||
      mimeType === "application/javascript")
  ) {
    return true;
  }
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : name.toLowerCase();
  return INLINE_TEXT_EXTENSIONS.has(ext);
}

/**
 * Orchestrate a file-upload submission for a `repo_mode='none'` assignment:
 * create an empty active submission, upload each file to the `submission-files`
 * bucket under `classes/{class}/profiles/{profile_or_group}/submissions/
 * {submission_id}/files/{name}`, then register the file rows. Returns the new
 * submission id.
 *
 * When `target` is omitted the caller submits for themselves (student flow).
 * When `target` is provided the caller is an instructor/grader submitting on
 * behalf of a student or group (`create_submission_for_student`).
 */
export async function uploadNoRepoSubmission(
  params: {
    assignment_id: number;
    files: PendingUploadFile[];
    target?: { profile_id?: string; assignment_group_id?: number };
  },
  supabase: SupabaseClient<Database>
): Promise<number> {
  let submissionId: number;
  if (params.target) {
    const { data, error } = await supabase.rpc("create_submission_for_student", {
      p_assignment_id: params.assignment_id,
      p_profile_id: params.target.profile_id ?? undefined,
      p_assignment_group_id: params.target.assignment_group_id ?? undefined
    });
    if (error) {
      Sentry.captureException(error);
      throw new EdgeFunctionError({
        details: error.message,
        message: "Failed to create submission on behalf of student",
        recoverable: false
      });
    }
    if (typeof data !== "number" || !Number.isFinite(data)) {
      throw new EdgeFunctionError({
        details: `Unexpected RPC result: ${JSON.stringify(data)}`,
        message: "Failed to create submission on behalf of student",
        recoverable: false
      });
    }
    submissionId = data;
  } else {
    submissionId = await createNoRepoSubmission({ assignment_id: params.assignment_id, files: [] }, supabase);
  }

  const { data: sub, error: subErr } = await supabase
    .from("submissions")
    .select("class_id, profile_id, assignment_group_id")
    .eq("id", submissionId)
    .single();
  if (subErr || !sub) {
    throw new EdgeFunctionError({
      details: subErr?.message ?? "submission not found after creation",
      message: "Failed to resolve submission for upload",
      recoverable: false
    });
  }

  const scopeId = sub.assignment_group_id ?? sub.profile_id;
  const prefix = `classes/${sub.class_id}/profiles/${scopeId}/submissions/${submissionId}/files`;
  const attached: AttachSubmissionFile[] = [];
  const usedNames = new Set<string>();
  for (const f of params.files) {
    // Keep the on-disk name but strip path separators so a malicious / odd name
    // can't escape the submission's prefix.
    let safeName = f.name.replace(/[/\\]/g, "_");
    // Two distinct files can sanitize to the same name; disambiguate so neither
    // the storage key nor the file row overwrites the other (e.g. `foo (2).md`).
    if (usedNames.has(safeName)) {
      const dot = safeName.lastIndexOf(".");
      const base = dot > 0 ? safeName.slice(0, dot) : safeName;
      const ext = dot > 0 ? safeName.slice(dot) : "";
      let n = 2;
      while (usedNames.has(`${base} (${n})${ext}`)) n++;
      safeName = `${base} (${n})${ext}`;
    }
    usedNames.add(safeName);
    if (isInlineTextUpload(safeName, f.mimeType, f.size)) {
      // Store text inline (like git text files) so the file viewer renders it.
      const contents = await f.file.text();
      attached.push({ name: safeName, file_size: f.size, mime_type: f.mimeType, is_binary: false, contents });
      continue;
    }
    const storageKey = `${prefix}/${safeName}`;
    const { error: uploadErr } = await supabase.storage.from("submission-files").upload(storageKey, f.file, {
      contentType: f.mimeType ?? undefined,
      upsert: true
    });
    if (uploadErr) {
      Sentry.captureException(uploadErr);
      throw new EdgeFunctionError({
        details: uploadErr.message,
        message: `Failed to upload ${f.name}`,
        recoverable: false
      });
    }
    attached.push({
      name: safeName,
      file_size: f.size,
      mime_type: f.mimeType,
      is_binary: true,
      storage_key: storageKey
    });
  }

  await attachNoRepoSubmissionFiles({ submission_id: submissionId, files: attached }, supabase);
  return submissionId;
}

/**
 * Create an instructor-authored stub submission for an assignment with
 * repo_mode='no_submission' (e.g. presentations / oral exams). Returns the
 * submission id — either the newly-created one or, if a manual submission was
 * already active for that profile/group, the existing one.
 */
export async function createManualSubmission(
  params: { assignment_id: number; profile_id?: string; assignment_group_id?: number },
  supabase: SupabaseClient<Database>
): Promise<number> {
  const { data, error } = await (supabase.rpc as CallableFunction)("create_manual_submission", {
    p_assignment_id: params.assignment_id,
    p_profile_id: params.profile_id ?? null,
    p_assignment_group_id: params.assignment_group_id ?? null
  });
  if (error) {
    Sentry.captureException(error);
    throw new EdgeFunctionError({
      details: error.message,
      message: "Failed to create manual submission",
      recoverable: false
    });
  }
  if (typeof data !== "number" || !Number.isFinite(data)) {
    throw new EdgeFunctionError({
      details: `Unexpected RPC result: ${JSON.stringify(data)}`,
      message: "Failed to create manual submission",
      recoverable: false
    });
  }
  return data;
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
export type CheckAppInstallationResponse = {
  installed: boolean;
  repo_accessible: boolean;
  org: string;
  install_url: string;
};

/**
 * Checks whether the Pawtograder GitHub App is installed in (and can see) `repo`
 * ("owner/name"). Used by the assignment config form to gate PR-mode assignments
 * whose upstream/handout repo may be in a different org than the class.
 */
export async function checkAppInstallation(
  params: { repo: string; class_id: number },
  supabase: SupabaseClient<Database>
): Promise<CheckAppInstallationResponse> {
  return await invokeEdgeFunction<CheckAppInstallationResponse>(supabase, "github-check-app-installation", {
    body: params
  });
}

export type PrLinkConfirmResponse = { submission_id: number | null };

/**
 * Confirms which candidate pull request is the submission PR for a pr-mode
 * assignment and ingests its current state as a submission. Used by the student
 * "which PR is your submission?" picker and by staff linking a PR manually.
 */
export async function confirmPrLink(
  params: { link_id: number },
  supabase: SupabaseClient<Database>
): Promise<PrLinkConfirmResponse> {
  return await invokeEdgeFunction<PrLinkConfirmResponse>(supabase, "pr-link-confirm", {
    body: params
  });
}

export type GetPrBaseFilesResponse = {
  /** Text files of the upstream base tree as { "path": "contents" }. */
  files: Record<string, string>;
  /** Present when the base fetch failed; the caller should fall back to the GitHub compare link. */
  error?: string;
};

/**
 * Fetch the upstream BASE tree (text files) for a pr-mode submission so the
 * Files view can render an inline base->head diff (head comes from the already
 * loaded `submission_files`). Results are served from an immutable, content
 * addressed cache; only one GitHub clone happens per (upstream_repo, base_sha).
 * Returns `{ files: {} }` for non-pr submissions or on clone failure so the UI
 * can degrade to the GitHub compare link.
 */
export async function getPrBaseFiles(
  submissionId: number,
  supabase: SupabaseClient<Database>
): Promise<GetPrBaseFilesResponse> {
  return await invokeEdgeFunction<GetPrBaseFilesResponse>(supabase, "get-pr-base-files", {
    body: { submission_id: submissionId }
  });
}

export type ListCommitsResponse = Endpoints["GET /repos/{owner}/{repo}/commits"]["response"];
export async function repositoryListCommits(
  params: FunctionTypes.RepositoryListCommitsRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ commits: ListCommitsResponse["data"]; has_more: boolean }>(
    supabase,
    "repository-list-commits",
    { body: params }
  );
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
  return await invokeEdgeFunction<FunctionTypes.AutograderTriggerGradingWorkflowResponse>(
    supabase,
    "autograder-trigger-grading-workflow",
    {
      body: params
    }
  );
}
export async function assignmentGroupInstructorCreateGroup(
  params: FunctionTypes.AssignmentGroupInstructorCreateRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<{ message: string; id: number }>(supabase, "assignment-group-instructor-create", {
    body: params
  });
}

export async function assignmentCreateHandoutRepo(
  params: FunctionTypes.AssignmentCreateHandoutRepoRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.AssignmentCreateHandoutRepoResponse>(
    supabase,
    "assignment-create-handout-repo",
    { body: params }
  );
}

export async function assignmentCreateSolutionRepo(
  params: FunctionTypes.AssignmentCreateSolutionRepoRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.AssignmentCreateSolutionRepoResponse>(
    supabase,
    "assignment-create-solution-repo",
    { body: params }
  );
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
  return await invokeEdgeFunction<FunctionTypes.AssignmentDeleteResponse>(supabase, "assignment-delete", {
    body: params
  });
}

export async function courseImportSis(params: FunctionTypes.CourseImportRequest, supabase: SupabaseClient<Database>) {
  return await invokeEdgeFunction<FunctionTypes.CourseImportResponse>(supabase, "course-import-sis", { body: params });
}

export async function invitationCreate(
  params: FunctionTypes.CreateInvitationRequest,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.CreateInvitationResponse>(supabase, "invitation-create", {
    body: params
  });
}

export async function userFetchAzureProfile(params: { accessToken: string }, supabase: SupabaseClient<Database>) {
  await invokeEdgeFunction(supabase, "user-fetch-azure-profile", { body: params });
}
export async function syncGitHubAccount(supabase: SupabaseClient<Database>) {
  return await invokeEdgeFunction<{ message: string }>(supabase, "github-user-sync", { body: {} });
}

export async function diagnoseInstructorGitHubAccount(
  params: Omit<FunctionTypes.InstructorGitHubDiagnoseRequest, "action">,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.InstructorGitHubDiagnoseResponse>(supabase, "github-user-sync", {
    body: { ...params, action: "diagnose" }
  });
}

export async function syncInstructorGitHubAccount(
  params: Omit<FunctionTypes.InstructorGitHubSyncRequest, "action">,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.InstructorGitHubSyncResponse>(supabase, "github-user-sync", {
    body: { ...params, action: "sync" }
  });
}

export async function unlinkInstructorGitHubAccount(
  params: Omit<FunctionTypes.InstructorGitHubUnlinkRequest, "action">,
  supabase: SupabaseClient<Database>
) {
  return await invokeEdgeFunction<FunctionTypes.InstructorGitHubUnlinkResponse>(supabase, "github-user-sync", {
    body: { ...params, action: "unlink" }
  });
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

function normalizeBodyError(err: unknown): { message: string; details: string; recoverable: boolean } {
  if (typeof err === "string") {
    return { message: err, details: "", recoverable: false };
  }
  const e = err as { message?: string; details?: string; recoverable?: boolean };
  return {
    message: e.message ?? "Unknown error",
    details: e.details ?? e.message ?? "Unknown error",
    recoverable: e.recoverable ?? false
  };
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
          throw new EdgeFunctionError(normalizeBodyError(body.error));
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
    throw new EdgeFunctionError(normalizeBodyError(response.error));
  }
  return data as T;
}

// API token scopes (MCP and CLI)
export type MCPScope = "mcp:read" | "mcp:write" | "cli:read" | "cli:write";

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
  return await invokeEdgeFunction<{ success: boolean; message: string }>(supabase, "mcp-tokens", {
    method: "DELETE",
    body: params
  });
}

// CLI Edge Function types

export interface CLIRequest {
  command: string;
  params: Record<string, unknown>;
}

export interface CLIResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Available CLI commands:
 *   READ (cli:read):
 *     - classes.list
 *     - classes.show { identifier }
 *     - assignments.list { class }
 *     - assignments.show { class, identifier }
 *     - rubrics.list { class, assignment }
 *     - rubrics.export { class, assignment, type? }
 *     - flashcards.list { class }
 *
 *   WRITE (cli:write):
 *     - surveys.copy { source_class, target_class, survey|all, target_assignment?, dry_run? }
 *     - assignments.copy { source_class, target_class, assignment|all|schedule, skip_repos?, skip_rubrics?, skip_surveys?, dry_run?, debug? }
 *     - assignments.delete { class, identifier }
 *     - rubrics.import { class, assignment, rubric, type?, dry_run? }
 *     - flashcards.copy { source_class, target_class, deck|all, dry_run? }
 */
export async function cliInvoke(params: CLIRequest, supabase: SupabaseClient<Database>): Promise<CLIResponse> {
  const cli = await invokeEdgeFunction<CLIResponse>(supabase, "cli", {
    body: params
  });
  if (cli.error) {
    throw new EdgeFunctionError({
      details: cli.error,
      message: cli.error,
      recoverable: false
    });
  }
  return cli;
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
