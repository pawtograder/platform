export type GitHubAsyncMethod =
  | "sync_student_team"
  | "sync_staff_team"
  | "create_repo"
  | "sync_repo_permissions"
  | "archive_repo_and_lock"
  | "rerun_autograder"
  | "sync_repo_to_handout"
  | "fetch_repo_analytics";

export type SyncTeamArgs = {
  org: string;
  courseSlug: string;
  userId?: string; // affected user to ensure org invitation
  /**
   * Invite `userId` without consulting `invitation_date`.
   *
   * Set only by the membership reconciler (`reconcile_stale_org_invitations`), which stamps
   * invitation_date as it enqueues — so by the time the worker opens this envelope the invitation
   * looks fresh and the ordinary staleness check would make the repair a no-op. The reconciler has
   * already applied the class's term window in SQL; see _shared/orgInviteWindow.ts.
   */
  forceReinvite?: boolean;
};

export type BranchProtectionConfig = {
  blockForcePush: boolean;
  requirePullRequest: boolean;
  requiredReviewers: number;
};

export type CreateRepoArgs = {
  org: string;
  repoName: string;
  templateRepo: string;
  isTemplateRepo?: boolean;
  courseSlug: string;
  githubUsernames: string[]; // direct inputs to sync permissions post-create
  /** Defaults to "template" — kept optional so existing queue messages still work. */
  creationMethod?: "template" | "fork";
  /** Required when creationMethod === "fork"; defaults to templateRepo otherwise. */
  sourceRepo?: string;
  /** Per-assignment branch protection ruleset. Defaults to blockForcePush=true. */
  branchProtection?: BranchProtectionConfig;
  /** Mode 2 handout: grant the `<slug>-students` team read access. */
  studentTeamPermission?: "pull" | null;
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

export type RerunAutograderArgs = {
  submission_id: number;
  repository: string;
  sha: string;
  repository_check_run_id: number;
  triggered_by: string;
  repository_id: number;
  grader_sha?: string;
  auto_promote?: boolean;
  target_submission_id: number;
};

export type SyncRepoToHandoutArgs = {
  repository_id: number;
  repository_full_name: string;
  template_repo: string;
  from_sha: string | null; // synced_handout_sha
  to_sha: string; // desired_handout_sha
  assignment_title: string;
  /**
   * Defaults to "template_pr" (existing behavior). When the student repo is a
   * GitHub fork (repo_mode = template_with_student_forks or
   * fork_from_prior_assignment) we prefer "fork_merge_upstream" — one API call
   * to GitHub's native fork-sync endpoint.
   */
  sync_strategy?: "template_pr" | "fork_merge_upstream";
  /**
   * For mode 3 (fork_from_prior_assignment) the upstream the student forked
   * isn't the assignment's template_repo (which is a borrowed copy). It's the
   * student's own prior-assignment repo. Provide it here when known.
   */
  upstream_repo_full_name?: string;
};

export type FetchRepoAnalyticsArgs = {
  assignment_id: number;
  org: string;
  /** Manual refresh: single repo (main queue). Mutually exclusive with `repository_ids` batch. */
  repository_id?: number | null;
  /** Bulk enqueue: fixed batch of repository PKs (e.g. 20 per message from SQL). */
  repository_ids?: number[] | null;
};

export type GitHubAsyncArgs =
  | SyncTeamArgs
  | CreateRepoArgs
  | SyncRepoPermissionsArgs
  | ArchiveRepoAndLockArgs
  | RerunAutograderArgs
  | SyncRepoToHandoutArgs
  | FetchRepoAnalyticsArgs;

export type GitHubAsyncEnvelope = {
  method: GitHubAsyncMethod;
  args: GitHubAsyncArgs;
  class_id?: number;
  debug_id?: string;
  log_id?: number;
  repo_id?: number; // Repository ID for create_repo operations
  retry_count?: number;
  /**
   * Readiness deferrals for `sync_repo_permissions`, counted SEPARATELY from `retry_count`.
   *
   * `retry_count` is the FAILURE budget: the circuit-breaker path DLQs at `retry_count >= 5`, and
   * the exception paths back off on it. A readiness deferral is not a failure — nothing has gone
   * wrong, the repository simply is not provisioned yet — so spending that budget on waiting means a
   * repo that needed five polls arrives at its first real GitHub error with the budget already gone
   * and gets DLQ'd instead of retried. Two meanings, two counters.
   */
  not_ready_count?: number;
  /**
   * `enqueued_at` of the FIRST message in this job's chain, carried across requeues.
   *
   * `requeueWithDelay` sends a new pgmq message, so `meta.enqueued_at` restarts on every requeue and
   * `recordMetric` would compute `latency_ms` from the last hop only. The api_gateway_calls row is
   * opened once for the whole job (it keys on `log_id`), so its latency has to be measured against
   * the original request or the aggregates under-report every job that ever waited.
   */
  original_enqueued_at?: string;
};
