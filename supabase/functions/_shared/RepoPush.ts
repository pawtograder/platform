import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.d.ts";
import { CheckRunStatus } from "./FunctionTypes.d.ts";
import { Database } from "./SupabaseTypes.d.ts";

/**
 * Push handling that both providers share (#1109). Each webhook converts its payload into a
 * `RepoPush`, then uses these steps: find the student repository on that provider, drop pushes that
 * are not to the default branch or that the assignment doesn't take, and record each commit in the
 * commit history. What happens after that (submissions, grading) is still GitHub's alone, in
 * github-repo-webhook; Forgejo grading is #1110.
 */

/** The values of `repositories.git_provider` and `assignments.git_provider`. */
export type GitProviderName = "github" | "forgejo";

type RepositoryRow = Database["public"]["Tables"]["repositories"]["Row"];

/** One pushed commit. The field names are GitHub's, and Forgejo's payload uses the same ones. */
export type RepoPushCommit = {
  id: string;
  message: string;
  timestamp: string;
  author: { name: string };
  removed: string[];
};

export type RepoPush = {
  provider: GitProviderName;
  /** `owner/name`, as stored in `repositories.repository`. */
  repository: string;
  ref: string;
  after: string;
  /** Missing when the payload doesn't say; treated as `main`. */
  defaultBranch?: string | null;
  headCommit: RepoPushCommit | null;
  /** Oldest first. */
  commits: RepoPushCommit[];
  /** How many commits the push had, when the payload says. `commits` can list fewer. */
  totalCommits?: number;
  pusherName: string;
};

/** The parts of GitHub's push payload that `RepoPush` carries. */
export type GitHubPushPayload = {
  ref: string;
  after: string;
  repository: { full_name: string; default_branch?: string | null };
  head_commit: RepoPushCommit | null;
  commits: RepoPushCommit[];
  pusher?: { name: string } | null;
};

export function fromGitHubPush(payload: GitHubPushPayload): RepoPush {
  return {
    provider: "github",
    repository: payload.repository.full_name,
    ref: payload.ref,
    after: payload.after,
    defaultBranch: payload.repository?.default_branch,
    headCommit: payload.head_commit,
    commits: payload.commits,
    // GitHub always sends `pusher`. Not reading it unguarded keeps a malformed payload failing where it
    // did before, in whatever step needs it, rather than here.
    pusherName: payload.pusher?.name ?? ""
  };
}

/**
 * The student repository a push is for, looked up on the push's provider only, so a Forgejo push
 * can never reach a GitHub repository that has the same `owner/name` (or the other way round).
 */
export async function findStudentRepository(
  adminSupabase: SupabaseClient<Database>,
  provider: GitProviderName,
  repository: string,
  scope: Sentry.Scope
): Promise<RepositoryRow | null> {
  const { data: studentRepo, error: studentRepoError } = await adminSupabase
    .from("repositories")
    .select("*")
    .eq("git_provider", provider)
    .eq("repository", repository)
    .maybeSingle();
  if (studentRepoError) {
    console.error(studentRepoError);
    scope.setTag("error_source", "student_repo_lookup_failed");
    scope.setTag("error_context", "Error getting student repo");
    Sentry.captureException(studentRepoError, scope);
    throw studentRepoError;
  }
  return studentRepo;
}

/**
 * Compare against the repo's ACTUAL default branch, not a hardcoded "main". For no-autograder
 * assignments the webhook is the only thing that creates submissions, so a repo whose default branch
 * is `master` (or anything else) had every push silently ignored. Actions-backed repos survived the
 * hardcoding because the workflow could still call autograder-create-submission. Falls back to
 * "main" when the payload omits default_branch.
 */
export function isDefaultBranchPush(push: RepoPush, scope: Sentry.Scope): boolean {
  const defaultBranch = push.defaultBranch || "main";
  if (push.ref !== `refs/heads/${defaultBranch}`) {
    scope.setTag("skipped_reason", "not_default_branch");
    scope.setTag("repo_default_branch", defaultBranch);
    return false;
  }
  return true;
}

// Named columns, not `*`: this query runs on EVERY push delivery for every student repo, and
// `assignments` carries an unbounded `description` body that nothing here reads. Naming them also
// keeps the column dependency visible to a rename.
const PUSH_ASSIGNMENT_COLUMNS =
  "id, submission_mode, has_autograder, repo_mode, allow_not_graded_submissions, permit_empty_submissions, latest_template_sha, max_late_tokens, require_tokens_before_due_date, classes(late_tokens_per_student)";

/** The assignment fields push handling reads. */
export type PushAssignment = {
  id: number;
  submission_mode: string | null;
  has_autograder: boolean | null;
  repo_mode: string | null;
  allow_not_graded_submissions: boolean | null;
  permit_empty_submissions: boolean | null;
  latest_template_sha: string | null;
  max_late_tokens: number | null;
  require_tokens_before_due_date: boolean | null;
  classes: { late_tokens_per_student: number | null } | null;
};

/**
 * `repo_mode` must still be a repo mode. Switching an existing assignment to none/no_submission
 * coerces has_autograder=false but leaves the old `repositories` rows behind, and a later push to
 * one of those would otherwise be recorded as a git submission for an upload-only assignment.
 */
export function assignmentHasRepository(assignment: PushAssignment | null): boolean {
  return assignment?.repo_mode !== "none" && assignment?.repo_mode !== "no_submission";
}

/**
 * Decides whether a push to a student repository is one Pawtograder acts on. Returns null (with
 * `skipped_reason` tagged where there is one) when it isn't, otherwise the repository's assignment,
 * which is null when no assignment on this provider matches the row.
 */
export async function acceptStudentRepoPush(
  adminSupabase: SupabaseClient<Database>,
  push: RepoPush,
  studentRepo: RepositoryRow,
  scope: Sentry.Scope
): Promise<{ assignment: PushAssignment | null } | null> {
  scope.setTag("webhook_handler", "push_to_student_repo");
  scope.setTag("repository", push.repository);
  scope.setTag("assignment_id", studentRepo.assignment_id.toString());
  scope.setTag("class_id", studentRepo.class_id.toString());
  scope.setTag("commits_count", push.commits.length.toString());

  console.log(`Handling push to student repo ${push.repository}, ref: ${push.ref}`);

  // pr-mode guard: when this repo's assignment takes submissions as pull requests
  // (submission_mode='pr'), a push to the fork's main is NOT a submission and
  // must not create a check run or dispatch grade.yml — the PR webhook handles
  // submissions. Skip rather than spin up a grading workflow.
  // Also load has_autograder + due-date inputs for the push-mode zero-runner
  // path (a push-mode assignment with no autograder creates the
  // submission directly instead of dispatching grade.yml).
  const { data: pushAssignment, error: pushAssignmentErr } = await adminSupabase
    .from("assignments")
    .select(PUSH_ASSIGNMENT_COLUMNS)
    .eq("git_provider", push.provider)
    .eq("id", studentRepo.assignment_id)
    .maybeSingle<PushAssignment>();
  if (pushAssignmentErr) {
    Sentry.captureException(pushAssignmentErr, scope);
    throw pushAssignmentErr;
  }
  if (pushAssignment?.submission_mode === "pr") {
    scope.setTag("skipped_reason", "pr_mode_assignment");
    console.log(`Skipping push handling for ${push.repository}: assignment is pr-mode`);
    return null;
  }

  if (push.ref.includes("refs/tags/pawtograder-submit/")) {
    // If we make a #submit commit or otherwise create a submission, it will trigger creating the tag, so don't do anything on the tag push.
    return null;
  }
  if (!push.headCommit) {
    console.error("No head commit found in payload");
    scope.setTag("error_source", "no_head_commit");
    scope.setTag("error_context", "No head commit found in payload");
    Sentry.captureException(new Error("No head commit found in payload"), scope);
    return null;
  }
  console.log(`Received push for ${push.repository}, message: ${push.headCommit.message}`);

  // A mode with no repository must skip the ACTIONS path as well, not just the
  // push-direct branch. Guarding only the branch meant a `#submit` push to one of those
  // leftover repos fell through, dispatched its stale grade.yml and stamped
  // workflow_triggered_at — which autograder-create-submission reads as a pre-disable
  // in-flight dispatch and therefore admits, producing an Actions-backed submission for an
  // assignment that has neither a repository nor an autograder. `pushAssignment` null (no
  // matching assignment) is left alone: that is a different case with its own handling
  // in the caller.
  if (pushAssignment && !assignmentHasRepository(pushAssignment)) {
    scope.setTag("skipped_reason", "assignment_repo_mode_has_no_repo");
    console.log(
      `Skipping push handling for ${push.repository}@${push.after}: assignment ${pushAssignment.id} is ` +
        `repo_mode=${pushAssignment.repo_mode}, so this repository is a leftover from a previous mode`
    );
    return null;
  }
  return { assignment: pushAssignment };
}

/**
 * Record one pushed commit in `repository_check_runs`.
 *
 * These rows are the commit history the student and staff UIs read
 * (`CommitHistoryDialog`, `staff-commit-history`), independently of whether any
 * Actions run is ever attached to them - `check_run_id` stays null until
 * one is. Shared by GitHub's Actions and push-direct paths, so a repo-only assignment
 * still has a commit history, and by Forgejo's webhook.
 *
 * Idempotent: a row already present for this repo+sha is left alone, and a
 * concurrent delivery losing the UNIQUE (repository_id, sha) race is a no-op.
 */
export async function recordCommitCheckRun(
  adminSupabase: SupabaseClient<Database>,
  studentRepo: RepositoryRow,
  push: RepoPush,
  commit: RepoPushCommit,
  scope: Sentry.Scope
): Promise<void> {
  const { data: existing, error: existingErr } = await adminSupabase
    .from("repository_check_runs")
    .select("id")
    .eq("repository_id", studentRepo.id)
    .eq("sha", commit.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    console.error(existingErr);
    scope.setTag("error_source", "repository_check_run_lookup_failed");
    scope.setTag("error_context", "Error checking existing repository_check_runs");
    Sentry.captureException(existingErr, scope);
    throw existingErr;
  }
  if (existing && existing.id) {
    return;
  }

  const status: CheckRunStatus = {
    created_at: new Date().toISOString(),
    commit_author: commit.author.name,
    commit_date: commit.timestamp,
    created_by: `${push.provider} push by ${push.pusherName}`
  };
  const { error: checkRunError } = await adminSupabase.from("repository_check_runs").insert({
    repository_id: studentRepo.id,
    check_run_id: null,
    class_id: studentRepo.class_id,
    assignment_group_id: studentRepo.assignment_group_id,
    commit_message: commit.message,
    sha: commit.id,
    profile_id: studentRepo.profile_id,
    status: status as unknown as Json
  });
  if (checkRunError) {
    // 23505 = unique_violation. With UNIQUE (repository_id, sha) the
    // SELECT-then-INSERT pattern above has a race window: concurrent webhook
    // deliveries for the same commit can both pass the SELECT, then one wins
    // the INSERT and the other returns 23505. Treat that as a no-op so we
    // don't throw and force the provider to retry the whole delivery.
    if (checkRunError.code === "23505") {
      scope.setTag("repository_check_run_insert_race", "true");
      return;
    }
    console.error(checkRunError);
    scope.setTag("error_source", "repository_check_run_insert_failed");
    scope.setTag("error_context", "Could not create repository_check_run");
    Sentry.captureException(checkRunError, scope);
    throw checkRunError;
  }
}
