import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { Database, Json } from "./SupabaseTypes.d.ts";

export const MISSING_GRADER_RESULT_MESSAGE = "Workflow terminated without creating a grader result.";
export const MISSING_GRADER_RESULT_USER_MESSAGE =
  "The grading container failed to terminate cleanly. This may indicate that the grading script ran out of memory or encountered an unexpected error. Please contact your instructor for assistance.";

export type MissingGraderResultRun = {
  repositoryId: number;
  classId: number;
  /** The run id submissions store as run_number. */
  runNumber: number;
  runAttempt: number;
  submission: { id: number; profile_id: string | null; assignment_group_id: number | null };
  /** The host's fields for the workflow_run_error row; error_type, detected_at and technical_details are added. */
  errorData: { [key: string]: Json | undefined };
  /** Host-specific Sentry tags, set once the result is known to be missing. */
  tagScope?: (scope: Sentry.Scope) => void;
};

/**
 * A finished grading run whose submission has no grader result: records a workflow_run_error and a zero-score
 * grader result, and reports it. Shared by GitHub's workflow_run and Forgejo's action_run completions. Skipped
 * when the submission has a result, or the run already reported a user-visible error. Errors are reported, not
 * thrown.
 */
export async function recordMissingGraderResult(
  adminSupabase: SupabaseClient<Database>,
  run: MissingGraderResultRun,
  scope: Sentry.Scope
): Promise<void> {
  const { repositoryId, classId, runNumber, runAttempt, submission } = run;
  const { data: graderResult, error: graderResultError } = await adminSupabase
    .from("grader_results")
    .select("id")
    .eq("submission_id", submission.id)
    .maybeSingle();
  if (graderResultError) {
    Sentry.captureException(graderResultError, scope);
    return;
  }
  const hasGraderResult = graderResult !== null;
  scope.setTag(`submission_${submission.id}_has_grader_result`, hasGraderResult.toString());
  if (hasGraderResult) return;

  const { data: userVisibleErrRows, error: userVisibleErrLookupError } = await adminSupabase
    .from("workflow_run_error")
    .select("id")
    .eq("repository_id", repositoryId)
    .eq("run_number", runNumber)
    .eq("run_attempt", runAttempt)
    .eq("data->>type", "user_visible_error")
    .limit(1);
  if (userVisibleErrLookupError) Sentry.captureException(userVisibleErrLookupError, scope);
  if (userVisibleErrRows && userVisibleErrRows.length > 0) {
    scope.setTag("missing_grader_result_skipped", "user_visible_error_present");
    return;
  }

  scope.setTag("error_type", "missing_grader_result");
  scope.setTag("workflow_run_id", runNumber.toString());
  scope.setTag("submission_id", submission.id.toString());
  run.tagScope?.(scope);

  const { error: insertError } = await adminSupabase.from("workflow_run_error").upsert(
    {
      repository_id: repositoryId,
      class_id: classId,
      submission_id: submission.id,
      run_number: runNumber,
      run_attempt: runAttempt,
      name: MISSING_GRADER_RESULT_USER_MESSAGE,
      data: {
        ...run.errorData,
        error_type: "missing_grader_result",
        detected_at: new Date().toISOString(),
        technical_details: MISSING_GRADER_RESULT_MESSAGE
      }
    },
    { onConflict: "repository_id,run_number,run_attempt,name" }
  );
  if (insertError) {
    Sentry.captureException(insertError, scope);
  } else {
    scope.setTag("workflow_run_error_created", "true");
  }

  const { error: insertGraderResultError } = await adminSupabase.from("grader_results").insert({
    submission_id: submission.id,
    errors: { error: MISSING_GRADER_RESULT_USER_MESSAGE },
    score: 0,
    ret_code: 137,
    lint_output: "",
    lint_output_format: "text",
    lint_passed: false,
    profile_id: submission.profile_id,
    assignment_group_id: submission.assignment_group_id,
    class_id: classId
  });
  if (insertGraderResultError) {
    Sentry.captureException(insertGraderResultError, scope);
  } else {
    scope.setTag("grader_result_created", "true");
  }

  Sentry.captureMessage(MISSING_GRADER_RESULT_MESSAGE, scope);
}
