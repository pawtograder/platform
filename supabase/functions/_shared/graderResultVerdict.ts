// Pure decision for "an autograder result already exists for this submission — may the incoming
// payload replace it?". Extracted so the truth table is testable without a Deno.serve host.
//
// The case that matters: when the grading action throws, it calls submitFeedback a SECOND time
// with ret_code 1, tests [], and a failed lint. That reaches the same submission under the same
// OIDC token, hits the unique constraint, and — because the real result is usually seconds old —
// takes the "reuse the existing row" path, which resets it. The reset deletes every
// grader_result_tests, grader_result_test_output, grader_result_output and workflow_run_error row
// for the submission and writes the empty payload over the top. The student's real grade is not
// shadowed, it is gone, and there is no record of what it was.
//
// The guard is server-side and unilateral on purpose. It must hold against the action that is
// deployed today, including historical action tags pinned to immutable refs that will never be
// rebuilt, so it cannot depend on the runner sending a new flag.

export type GraderFeedbackShape = {
  score?: number;
  tests?: unknown[];
  artifacts?: unknown[];
  annotations?: unknown[];
};

/**
 * Did this payload carry anything that can be GRADED?
 *
 * Deliberately ignores `feedback.output.*`, `feedback.lint.output` and the top-level `output`.
 * Those are diagnostics, and a grader that crashes writes its stack trace into exactly those
 * fields — counting them as content would make this return true on precisely the payload the
 * guard exists to reject, so the guard would never fire.
 *
 * A score of 0 is not content either: "0 points" is indistinguishable from "no score computed",
 * and a real 0 with no tests has nothing to lose by being preserved.
 */
export function hasGradeableContent(feedback: GraderFeedbackShape | null | undefined): boolean {
  if (!feedback) return false;
  if ((feedback.tests?.length ?? 0) > 0) return true;
  if (typeof feedback.score === "number" && feedback.score > 0) return true;
  if ((feedback.artifacts?.length ?? 0) > 0) return true;
  if ((feedback.annotations?.length ?? 0) > 0) return true;
  return false;
}

export type GraderResultConflictVerdict =
  /** Replace the existing result with the incoming payload (previous behavior). */
  | "overwrite"
  /** Keep the existing result; record the failure alongside it. */
  | "preserve"
  /** The existing result is too old to rewrite; reject the request. */
  | "reject_stale";

export type GraderResultConflictInputs = {
  /** `requestBody.ret_code`. Non-numeric/missing is treated as "not a reported failure". */
  retCode: number | null | undefined;
  /** `hasGradeableContent(requestBody.feedback)`. */
  gradeable: boolean;
  /** `isRegressionRerun && autoPromoteResult` — a promotion may rewrite a result of any age. */
  allowStaleOverwrite: boolean;
  /** Age of the existing result in ms. */
  existingAgeMs: number;
  /** `RESET_WINDOW_MS`. */
  resetWindowMs: number;
};

/**
 * Truth table:
 *
 * | retCode | gradeable | allowStale | age > window | verdict      | why                        |
 * |---------|-----------|------------|--------------|--------------|----------------------------|
 * | any     | any       | false      | true         | reject_stale | pre-existing replay guard  |
 * | != 0    | false     | any        | false        | preserve     | the fix: a failed, empty   |
 * |         |           |            |              |              | run must not erase a grade |
 * | != 0    | false     | true       | any          | preserve     | same, for a rerun          |
 * | any     | true      | any        | false        | overwrite    | real result, fresh window  |
 * | 0       | false     | any        | false        | overwrite    | legitimate empty re-submit |
 * | any     | true      | true       | true         | overwrite    | regression rerun promotion |
 *
 * `reject_stale` is checked FIRST because it is the only verdict that writes nothing at all.
 * Letting `preserve` outrank it would hand the anti-replay window away: a replayed request shaped
 * as a failed empty run is exactly the payload that reaches `preserve`, and that path still writes
 * -- it stamps a student-visible message onto grader_results.errors, inserts a public
 * workflow_run_error row, completes the check run and answers 200. Refusing outright is strictly
 * safer than preserving, and preserves the grade just as completely.
 *
 * `preserve` does deliberately outrank `allowStaleOverwrite`: an instructor's rerun that crashed
 * should not destroy the result it was meant to replace either.
 *
 * Conservative by construction — a missing `ret_code` is not read as failure, so an older or
 * non-conforming runner keeps exactly today's behavior rather than silently having writes
 * dropped.
 */
export function resolveGraderResultConflictVerdict(inputs: GraderResultConflictInputs): GraderResultConflictVerdict {
  const { retCode, gradeable, allowStaleOverwrite, existingAgeMs, resetWindowMs } = inputs;

  if (!allowStaleOverwrite && existingAgeMs > resetWindowMs) return "reject_stale";

  const reportedFailure = typeof retCode === "number" && retCode !== 0;
  if (reportedFailure && !gradeable) return "preserve";

  return "overwrite";
}
