export type GitHubAsyncMethod =
  | "sync_student_team"
  | "sync_staff_team"
  | "create_repo"
  | "sync_repo_permissions"
  | "archive_repo_and_lock";

export type SyncTeamArgs = {
  org: string;
  courseSlug: string;
};

export type CreateRepoArgs = {
  org: string;
  repoName: string;
  templateRepo: string;
  isTemplateRepo?: boolean;
  courseSlug: string;
  githubUsernames: string[]; // direct inputs to sync permissions post-create
};

export type SyncRepoPermissionsArgs = {
  org: string;
  repo: string; // may be full_name or short name; worker normalizes
  courseSlug: string;
  githubUsernames: string[]; // lowercase preferred
};

export type AddPushWebhookArgs = {
  repoFullName: string; // owner/repo
  hookType: "grader_solution" | "template_repo";
};

export type RemovePushWebhookArgs = {
  repoFullName: string; // owner/repo
  webhookId: number;
};

export type TriggerWorkflowArgs = {
  repoFullName: string;
  sha: string;
  workflowName: string; // file name or id accepted by Octokit
};

export type CreateCheckRunArgs = {
  repoFullName: string;
  sha: string;
  detailsUrl: string;
};

export type UpdateCheckRunArgs = {
  owner: string;
  repo: string;
  check_run_id: number;
  status?: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "stale";
  output?: {
    title?: string;
    summary?: string;
    text?: string;
  };
  details_url?: string;
};

export type ArchiveRepoAndLockArgs = {
  org: string;
  repo: string; // may be full_name or short name
};

export type GitHubAsyncArgs = SyncTeamArgs | CreateRepoArgs | SyncRepoPermissionsArgs | ArchiveRepoAndLockArgs;

export type GitHubAsyncEnvelope = {
  method: GitHubAsyncMethod;
  args: GitHubAsyncArgs;
  class_id?: number;
  debug_id?: string;
};
