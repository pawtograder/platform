/**
 * Deno-side counterpart of `lib/graderResultStatus.ts`.
 *
 * Deliberately duplicated rather than shared: `lib/` is Next.js code reached through the `@/`
 * alias, which does not resolve under Deno, and this is a pure five-line predicate. Both copies
 * must agree — if the marker changes, change both. The frontend copy is the one that decides
 * whether a score is displayed; this one decides whether it is safe to overwrite a payload.
 *
 * `grader_results.errors` is free-form jsonb whose only reader used to be truthiness. The
 * empty-run guard in autograder-submit-feedback also writes there, to say a run was discarded and
 * the previous results kept, so that case carries `is_warning: true` to distinguish it. Everything
 * else — including every payload written before the marker existed — is a failure.
 */
export function graderResultErrorsIndicateFailure(errors: unknown): boolean {
  if (!errors) {
    return false;
  }
  if (
    typeof errors === "object" &&
    !Array.isArray(errors) &&
    (errors as { is_warning?: unknown }).is_warning === true
  ) {
    return false;
  }
  return true;
}
