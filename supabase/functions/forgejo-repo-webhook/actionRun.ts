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
  created_at: string;
};

/**
 * Allowance for the Forgejo host's clock running ahead of the database's when a submission's created_at
 * is compared with the run's stop time. A re-run cannot start until the attempt before it has stopped,
 * and its submission is created only after a runner has picked the job up and checked the commit out, so
 * the next attempt's submission is always far more than this past the previous attempt's stop time.
 */
const CLOCK_SKEW_MS = 5_000;

/**
 * The submissions the completion describes. Forgejo's payload has no attempt number and a re-run keeps
 * the run's id, so it is inferred from timing: a submission is created while its attempt runs, so the
 * attempt that stopped at `stoppedAt` is the latest one whose submission already existed by then. Taking
 * the highest attempt visible on arrival instead pinned a late delivery for attempt 1 on attempt 2, and
 * gave attempt 2 a zero-score result before its grader had reported.
 */
export function attributeRunAttempt(
  submissions: RunSubmission[],
  stoppedAt: string | null
): { runAttempt: number; submissions: RunSubmission[] } {
  if (submissions.length === 0) return { runAttempt: 1, submissions: [] };
  const highest = (rows: RunSubmission[]) => rows.reduce((max, s) => Math.max(max, s.run_attempt), 0);
  const stopped = stoppedAt ? new Date(stoppedAt).getTime() : NaN;
  if (Number.isNaN(stopped)) {
    const runAttempt = highest(submissions) || 1;
    return { runAttempt, submissions: submissions.filter((s) => s.run_attempt === runAttempt) };
  }
  const before = submissions.filter((s) => new Date(s.created_at).getTime() <= stopped + CLOCK_SKEW_MS);
  if (before.length === 0) {
    // The attempt that stopped made no submission (it failed before reaching the grader), and every
    // submission seen belongs to a later attempt. Nothing here is this completion's to report on.
    const earliest = submissions.reduce((min, s) => Math.min(min, s.run_attempt), Infinity);
    return { runAttempt: Math.max(1, earliest - 1), submissions: [] };
  }
  const runAttempt = highest(before) || 1;
  return { runAttempt, submissions: before.filter((s) => s.run_attempt === runAttempt) };
}

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
  // attempts. The job's OIDC token carries that count onto the submission, and attributeRunAttempt picks
  // the attempt this completion describes.
  let runSubmissions: RunSubmission[] = [];
  if (studentRepo) {
    const { data, error } = await adminSupabase
      .from("submissions")
      .select("id, run_attempt, profile_id, assignment_group_id, created_at")
      .eq("repository_id", studentRepo.id)
      .eq("sha", run.commit_sha)
      .eq("run_number", run.id);
    if (error) {
      scope.setTag("error_source", "forgejo_action_run_submissions_lookup_failed");
      Sentry.captureException(error, scope);
      throw error;
    }
    runSubmissions = (data ?? []) as RunSubmission[];
  }
  const stoppedAt = forgejoTime(run.stopped) ?? forgejoTime(run.updated);
  const { runAttempt, submissions } = attributeRunAttempt(runSubmissions, stoppedAt);

  // The table has no unique key for a run's completion, so a redelivered hook would add a second row and
  // the Checks tab would list the run twice. A re-run of the same run id stops at a different time, so it
  // is not mistaken for a redelivery.
  let existingEvent = adminSupabase
    .from("workflow_events")
    .select("id")
    .eq("head_sha", run.commit_sha)
    .eq("workflow_run_id", run.id)
    .eq("event_type", "completed")
    .eq("run_attempt", runAttempt);
  if (stoppedAt) existingEvent = existingEvent.eq("run_updated_at", stoppedAt);
  const { data: existingRows, error: existingError } = await existingEvent.limit(1);
  if (existingError) {
    scope.setTag("error_source", "workflow_events_lookup_failed");
    Sentry.captureException(existingError, scope);
    throw existingError;
  }
  if ((existingRows ?? []).length > 0) {
    scope.setTag("duplicate_action_run", "true");
    console.log(`[forgejo-repo-webhook] run=${run.id} attempt=${runAttempt} already logged; not logging it again`);
  } else {
    await insertWorkflowEvent(adminSupabase, run, studentRepo, runAttempt, stoppedAt, scope);
  }

  if (!studentRepo) {
    return;
  }
  // A student can add workflows of their own; only the grading run says anything about the commit.
  if (run.workflow_id === GRADE_WORKFLOW_FILE) {
    await recordRunOnCheckRun(adminSupabase, studentRepo.id, run, stoppedAt, scope);
  }
  // Both steps below are safe to repeat: the check run keeps the newest run it has seen, and a submission
  // that already has a grader result is left alone.
  for (const submission of submissions) {
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

async function insertWorkflowEvent(
  adminSupabase: SupabaseClient<Database>,
  run: ForgejoActionRun,
  studentRepo: { id: number; class_id: number } | null,
  runAttempt: number,
  stoppedAt: string | null,
  scope: Sentry.Scope
): Promise<void> {
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
}

/**
 * Puts the run's URL and outcome on the commit's check-run row. Feedback sets completed_at when the
 * grader reports, which a failed or cancelled run never does, so it is filled in here if still empty.
 *
 * Deliveries are not ordered. Re-running grading on the same commit produces a second run, and the
 * first run's completion can arrive after the second's — Forgejo retries a hook the receiver was slow
 * to answer, so a failure from the superseded run could otherwise land on top of the re-run's success
 * and show the student a failing check for a run that is no longer the current one. The row therefore
 * keeps whichever run id is highest: Forgejo's run ids increase, so that is the most recent run for
 * this commit. A re-run of the same run keeps its id, so between deliveries of one run the later stop
 * time wins. A delivery of what is already recorded changes nothing, which makes the duplicate that
 * `action_run_recover` (and any hook retry) produces a no-op rather than a rewrite.
 *
 * The write is a compare-and-swap on the status it was decided from. Two deliveries can both read the
 * row before either writes, and the autograder's feedback also rewrites this status; a plain update
 * could then land an older run over a newer one, or put back fields the other writer had just set. When
 * the status changed in between, the row is read again and the ordering decided afresh.
 */
async function recordRunOnCheckRun(
  adminSupabase: SupabaseClient<Database>,
  repositoryId: number,
  run: ForgejoActionRun,
  stoppedAt: string | null,
  scope: Sentry.Scope
): Promise<void> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
    // The exact value the write below is conditional on, taken before anything else runs.
    const readStatus = JSON.stringify(checkRun.status);
    const status = (checkRun.status ?? {}) as CheckRunStatus;
    const verdict = compareWithRecordedRun(status, run, stoppedAt);
    if (verdict === "older") {
      // A superseded run's completion, delivered late. The row already holds a newer run for this commit.
      scope.setTag("stale_action_run", "true");
      console.log(
        `[forgejo-repo-webhook] run ${run.id} for ${run.commit_sha} is older than the recorded run ` +
          `${status.workflow_run_id}; leaving the check run as it is`
      );
      return;
    }
    if (verdict === "same") {
      // The same run delivered twice (a hook retry, or action_run_recover's copy of the success).
      scope.setTag("duplicate_action_run", "true");
      return;
    }
    const newStatus: CheckRunStatus = {
      ...status,
      completed_at: status.completed_at ?? stoppedAt ?? new Date().toISOString(),
      conclusion: run.status,
      workflow_run_id: run.id,
      workflow_run_url: run.html_url,
      workflow_run_stopped_at: stoppedAt ?? undefined
    };
    const { data: written, error: updateError } = await adminSupabase
      .from("repository_check_runs")
      .update({ status: newStatus as unknown as Json })
      .eq("id", checkRun.id)
      // jsonb equality, so this matches only while the row still holds the status read above.
      .eq("status", readStatus)
      .select("id");
    if (updateError) {
      scope.setTag("error_source", "repository_check_run_status_update_failed");
      Sentry.captureException(updateError, scope);
      throw updateError;
    }
    if ((written ?? []).length > 0) return;
    scope.setTag("check_run_status_write_conflicts", attempt.toString());
  }
  const conflict = new Error(
    `repository_check_runs status for ${run.commit_sha} kept changing; run ${run.id} was not recorded`
  );
  scope.setTag("error_source", "repository_check_run_status_update_conflict");
  Sentry.captureException(conflict, scope);
  throw conflict;
}

/** Where `run` falls against the run the check-run status already records. */
export function compareWithRecordedRun(
  status: CheckRunStatus,
  run: Pick<ForgejoActionRun, "id" | "status" | "html_url">,
  stoppedAt: string | null
): "older" | "same" | "newer" {
  const recordedRunId = typeof status.workflow_run_id === "number" ? status.workflow_run_id : null;
  if (recordedRunId === null || run.id > recordedRunId) return "newer";
  if (run.id < recordedRunId) return "older";
  // The same run id: a redelivery, or another attempt of a re-run, which stops later.
  const recordedStop = status.workflow_run_stopped_at ? new Date(status.workflow_run_stopped_at).getTime() : NaN;
  const incomingStop = stoppedAt ? new Date(stoppedAt).getTime() : NaN;
  if (!Number.isNaN(recordedStop) && !Number.isNaN(incomingStop)) {
    if (incomingStop < recordedStop) return "older";
    if (incomingStop > recordedStop) return "newer";
  }
  return status.conclusion === run.status && status.workflow_run_url === run.html_url ? "same" : "newer";
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
