import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type { CheckRunStatus } from "../_shared/FunctionTypes.d.ts";
import { findStudentRepository } from "../_shared/RepoPush.ts";
import { Database, Json } from "../_shared/SupabaseTypes.d.ts";

/**
 * Forgejo's Actions webhooks (`action_run_success`, `action_run_failure`, `action_run_recover`), which
 * Forgejo sends once a run is done. It has no event for a run being requested or starting, so this is
 * the Forgejo counterpart of GitHub's `workflow_run` "completed" only.
 */
export const FORGEJO_ACTION_RUN_EVENTS = ["action_run_success", "action_run_failure"] as const;

/**
 * Forgejo also sends `action_run_recover`, after the `action_run_success` for the same run, when the
 * workflow's previous run failed. It carries the same run, so it is acknowledged and not handled twice.
 */
export const FORGEJO_IGNORED_ACTION_RUN_EVENTS = ["action_run_recover"] as const;

/** The file name the handout's grading workflow is committed under (`.github/workflows/grade.yml`). */
export const GRADE_WORKFLOW_FILE = "grade.yml";

/** The fields of Forgejo's `api.ActionRun` the handler reads. */
export type ForgejoActionRun = {
  /** Instance-wide run id. A job's OIDC token carries it as `run_id`, so submissions store it as run_number. */
  id: number;
  /** The run's number within its repository, as shown in the Actions UI and its URL. */
  index_in_repo?: number | null;
  /** The workflow's file name, e.g. "grade.yml". */
  workflow_id: string;
  commit_sha: string;
  /** "main" for a branch, "v1" for a tag. */
  prettyref?: string | null;
  /** "success", "failure", "cancelled" or "skipped". */
  status: string;
  event?: string | null;
  title?: string | null;
  trigger_user?: { login?: string | null } | null;
  /** Go encodes a time that was never set as 0001-01-01T00:00:00Z. */
  started?: string | null;
  stopped?: string | null;
  updated?: string | null;
  html_url: string;
  repository: { id?: number | null; full_name: string; html_url?: string | null };
};

/** Forgejo's `api.ActionPayload`. */
export type ForgejoActionRunPayload = {
  action: string;
  run: ForgejoActionRun;
  prior_status?: string | null;
};

export function isForgejoActionRunPayload(payload: unknown): payload is ForgejoActionRunPayload {
  const run = (payload as ForgejoActionRunPayload | null)?.run;
  return (
    typeof run?.id === "number" &&
    typeof run.workflow_id === "string" &&
    typeof run.commit_sha === "string" &&
    typeof run.status === "string" &&
    typeof run.html_url === "string" &&
    typeof run.repository?.full_name === "string"
  );
}

/** A Go time as ISO 8601, or null for the zero time and anything unparseable. */
export function forgejoTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1) return null;
  return date.toISOString();
}

// Same text github-repo-webhook writes for a GitHub run that ends without a grader result.
const MISSING_RESULT_MESSAGE = "Workflow terminated without creating a grader result.";
const MISSING_RESULT_USER_MESSAGE =
  "The grading container failed to terminate cleanly. This may indicate that the grading script ran out of memory or encountered an unexpected error. Please contact your instructor for assistance.";

type RunSubmission = {
  id: number;
  run_attempt: number;
  profile_id: string | null;
  assignment_group_id: number | null;
};

/**
 * Records a finished Forgejo Actions run, as github-repo-webhook does for GitHub's `workflow_run`:
 *  - a `workflow_events` row, which the submission's Checks tab and the workflow run pages read;
 *  - for the grading workflow, the run's URL and outcome on the commit's `repository_check_runs` row,
 *    so Commit History shows a failed or cancelled run as finished and links to it;
 *  - for a submission the run created that never got a grader result, a workflow_run_error and an
 *    error grader result, so the student sees the run failed instead of a result that never comes.
 */
export async function handleForgejoActionRun(
  adminSupabase: SupabaseClient<Database>,
  run: ForgejoActionRun,
  scope: Sentry.Scope
): Promise<void> {
  scope.setTag("workflow_run_id", run.id.toString());
  scope.setTag("workflow_conclusion", run.status);
  scope.setTag("forgejo_actions_run_url", run.html_url);

  const studentRepo = await findStudentRepository(adminSupabase, "forgejo", run.repository.full_name, scope);
  if (studentRepo) {
    scope.setTag("repository_id", studentRepo.id.toString());
    scope.setTag("class_id", studentRepo.class_id.toString());
  }

  // Forgejo's payload has no attempt number: a re-run keeps the run's id, and each job counts its own
  // attempts. The job's OIDC token carries that count, so the latest submission for this run has it.
  let submissions: RunSubmission[] = [];
  if (studentRepo) {
    const { data, error } = await adminSupabase
      .from("submissions")
      .select("id, run_attempt, profile_id, assignment_group_id")
      .eq("repository_id", studentRepo.id)
      .eq("sha", run.commit_sha)
      .eq("run_number", run.id);
    if (error) {
      scope.setTag("error_source", "forgejo_action_run_submissions_lookup_failed");
      Sentry.captureException(error, scope);
      throw error;
    }
    submissions = (data ?? []) as RunSubmission[];
  }
  const runAttempt = submissions.reduce((max, s) => Math.max(max, s.run_attempt), 0) || 1;

  const stoppedAt = forgejoTime(run.stopped) ?? forgejoTime(run.updated);
  const { error: insertError } = await adminSupabase.from("workflow_events").insert({
    workflow_run_id: run.id,
    repository_name: run.repository.full_name,
    // The column holds GitHub's repository id; a Forgejo id would collide with those.
    github_repository_id: null,
    repository_id: studentRepo?.id ?? null,
    class_id: studentRepo?.class_id ?? null,
    // Forgejo's payload has the workflow's file name but not its `name:`.
    workflow_name: run.workflow_id,
    workflow_path: run.workflow_id,
    event_type: "completed",
    status: "completed",
    conclusion: run.status,
    head_sha: run.commit_sha,
    head_branch: run.prettyref ?? null,
    run_number: run.index_in_repo ?? null,
    run_attempt: runAttempt,
    actor_login: run.trigger_user?.login ?? null,
    triggering_actor_login: run.trigger_user?.login ?? null,
    started_at: forgejoTime(run.started),
    updated_at: stoppedAt,
    run_started_at: forgejoTime(run.started),
    run_updated_at: stoppedAt,
    pull_requests: null,
    payload: { provider: "forgejo", run } as unknown as Json
  });
  if (insertError) {
    scope.setTag("error_source", "workflow_events_insert_failed");
    scope.setTag("error_context", "Failed to store Forgejo workflow event");
    Sentry.captureException(insertError, scope);
    throw insertError;
  }
  console.log(`[forgejo-repo-webhook] Logged ${run.status} for run=${run.id} attempt=${runAttempt}`);

  if (!studentRepo) {
    return;
  }
  // A student can add workflows of their own; only the grading run says anything about the commit.
  if (run.workflow_id === GRADE_WORKFLOW_FILE) {
    await recordRunOnCheckRun(adminSupabase, studentRepo.id, run, stoppedAt, scope);
  }
  const latest = submissions.filter((s) => s.run_attempt === runAttempt);
  for (const submission of latest) {
    await reportMissingGraderResult(
      adminSupabase,
      studentRepo.id,
      studentRepo.class_id,
      run,
      runAttempt,
      submission,
      scope
    );
  }
}

/**
 * Puts the run's URL and outcome on the commit's check-run row. Feedback sets completed_at when the
 * grader reports, which a failed or cancelled run never does, so it is filled in here if still empty.
 */
async function recordRunOnCheckRun(
  adminSupabase: SupabaseClient<Database>,
  repositoryId: number,
  run: ForgejoActionRun,
  stoppedAt: string | null,
  scope: Sentry.Scope
): Promise<void> {
  const { data: checkRun, error: lookupError } = await adminSupabase
    .from("repository_check_runs")
    .select("id, status")
    .eq("repository_id", repositoryId)
    .eq("sha", run.commit_sha)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupError) {
    scope.setTag("error_source", "repository_check_run_lookup_failed");
    Sentry.captureException(lookupError, scope);
    throw lookupError;
  }
  if (!checkRun) {
    // The push that would have created it hasn't arrived, or wasn't to the default branch.
    scope.setTag("check_run_missing", "true");
    return;
  }
  const status = (checkRun.status ?? {}) as CheckRunStatus;
  const newStatus: CheckRunStatus = {
    ...status,
    completed_at: status.completed_at ?? stoppedAt ?? new Date().toISOString(),
    conclusion: run.status,
    workflow_run_id: run.id,
    workflow_run_url: run.html_url
  };
  const { error: updateError } = await adminSupabase
    .from("repository_check_runs")
    .update({ status: newStatus as unknown as Json })
    .eq("id", checkRun.id);
  if (updateError) {
    scope.setTag("error_source", "repository_check_run_status_update_failed");
    Sentry.captureException(updateError, scope);
    throw updateError;
  }
}

/** handleWorkflowCompletionErrors in github-repo-webhook, for one submission of a Forgejo run. */
async function reportMissingGraderResult(
  adminSupabase: SupabaseClient<Database>,
  repositoryId: number,
  classId: number,
  run: ForgejoActionRun,
  runAttempt: number,
  submission: RunSubmission,
  scope: Sentry.Scope
): Promise<void> {
  const { data: graderResult, error: graderResultError } = await adminSupabase
    .from("grader_results")
    .select("id")
    .eq("submission_id", submission.id)
    .maybeSingle();
  if (graderResultError) {
    Sentry.captureException(graderResultError, scope);
    return;
  }
  if (graderResult) return;

  // The grader already told the student what went wrong; a second, vaguer error would bury it.
  const { data: userVisible, error: userVisibleError } = await adminSupabase
    .from("workflow_run_error")
    .select("id")
    .eq("repository_id", repositoryId)
    .eq("run_number", run.id)
    .eq("run_attempt", runAttempt)
    .eq("data->>type", "user_visible_error")
    .limit(1);
  if (userVisibleError) Sentry.captureException(userVisibleError, scope);
  if (userVisible && userVisible.length > 0) {
    scope.setTag("missing_grader_result_skipped", "user_visible_error_present");
    return;
  }

  const submissionScope = scope.clone();
  submissionScope.setTag("error_type", "missing_grader_result");
  submissionScope.setTag("submission_id", submission.id.toString());

  const { error: errorRowError } = await adminSupabase.from("workflow_run_error").upsert(
    {
      repository_id: repositoryId,
      class_id: classId,
      submission_id: submission.id,
      run_number: run.id,
      run_attempt: runAttempt,
      name: MISSING_RESULT_USER_MESSAGE,
      data: {
        workflow_run_id: run.id,
        workflow_run_url: run.html_url,
        workflow_conclusion: run.status,
        workflow_status: "completed",
        repository_name: run.repository.full_name,
        sha: run.commit_sha,
        error_type: "missing_grader_result",
        detected_at: new Date().toISOString(),
        technical_details: MISSING_RESULT_MESSAGE
      }
    },
    { onConflict: "repository_id,run_number,run_attempt,name" }
  );
  if (errorRowError) Sentry.captureException(errorRowError, submissionScope);

  const { error: resultError } = await adminSupabase.from("grader_results").insert({
    submission_id: submission.id,
    errors: { error: MISSING_RESULT_USER_MESSAGE },
    score: 0,
    ret_code: 137,
    lint_output: "",
    lint_output_format: "text",
    lint_passed: false,
    profile_id: submission.profile_id,
    assignment_group_id: submission.assignment_group_id,
    class_id: classId
  });
  if (resultError) Sentry.captureException(resultError, submissionScope);

  Sentry.captureMessage(MISSING_RESULT_MESSAGE, submissionScope);
}
