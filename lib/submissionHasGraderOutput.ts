/**
 * Whether a submission had autograder activity worth showing on the Results tab.
 * Covers tests, lint/build logs, captured grader stdout/stderr rows, structured `errors` JSON,
 * and optional `build_failures` / `build_failure_summary` if present on the row.
 */
export function submissionHasGraderOutput(
  graderResults:
    | {
        grader_result_tests?: unknown[] | null;
        lint_output?: string | null;
        grader_result_output?: unknown[] | null;
        errors?: unknown;
        build_failures?: unknown[] | null;
        build_failure_summary?: string | null;
      }
    | null
    | undefined
): boolean {
  if (!graderResults) {
    return false;
  }
  if ((graderResults.grader_result_tests?.length ?? 0) > 0) {
    return true;
  }
  if ((graderResults.lint_output?.trim().length ?? 0) > 0) {
    return true;
  }
  if ((graderResults.grader_result_output?.length ?? 0) > 0) {
    return true;
  }
  if (graderResults.errors != null) {
    return true;
  }
  const buildFailures = graderResults.build_failures;
  if (Array.isArray(buildFailures) && buildFailures.length > 0) {
    return true;
  }
  const summary = graderResults.build_failure_summary;
  return summary != null && String(summary).trim().length > 0;
}
