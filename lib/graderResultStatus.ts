/**
 * Does a grader result's `errors` payload mean the run FAILED?
 *
 * `grader_results.errors` is free-form jsonb and had exactly one reader everywhere it appeared:
 * truthiness. That was fine while the only thing written to it was a failure, but the
 * empty-run guard in `autograder-submit-feedback` also writes there — to tell a student that an
 * empty failed run was discarded and their previous results kept. Under a truthiness test the
 * views then rendered "Error" in place of the score the guard had just gone to the trouble of
 * preserving, which defeats the guard entirely.
 *
 * So the payload carries `is_warning: true` for that case, and this is the single place that
 * knows it. Anything else — including every legacy payload, which has no marker — stays a
 * failure, so the default is unchanged and only the explicitly-marked warning is excluded.
 *
 * Mirrored for Deno at `supabase/functions/_shared/graderResultStatus.ts`, which the edge function
 * that WRITES the marker uses to avoid overwriting a real failure. The `@/` alias does not resolve
 * under Deno, so the two are duplicated on purpose; if the marker changes, change both.
 */
export function graderResultIndicatesFailure(errors: unknown): boolean {
  // Nullish only. `!errors` also swallowed `false`, `0` and `""` -- and since this file's whole
  // contract is "anything that is not the explicit warning marker is a failure", a malformed falsy
  // payload silently bypassed failure handling instead of being treated as one.
  if (errors === null || errors === undefined) {
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
