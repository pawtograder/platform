/**
 * Pure state rules for a student's own survey response, used by
 * `app/course/[course_id]/surveys/[survey_id]/page.tsx`.
 *
 * They live outside the page component because they decide whether a submission survives a
 * page reload or silently reverts to a draft, and that is worth testing without mounting
 * SurveyJS.
 *
 * The invariant: once a response row is `is_submitted = true`, nothing this page writes may
 * set it back to false. Autosave is what used to break it -- the page's "already submitted"
 * flag was only ever set by a submit made in the same browser session, so on a fresh load of
 * a submitted response the first keystroke autosaved `is_submitted: false` over it. The
 * database does not defend the invariant either: `survey_responses_update_owner` permits an
 * update to a submitted row whenever the survey has `allow_response_editing`, and the draft
 * upsert omits `submitted_at`, so a downgraded row claims not to be submitted while still
 * carrying a submission timestamp.
 *
 * The fix is not to stop the write. `allow_response_editing` is a real feature: the survey
 * model renders in its running state with a live Complete button, so a student may edit and
 * re-submit. Autosave on an already-submitted response therefore persists the edit *as
 * submitted*, leaving `submitted_at` alone so the original submission time survives.
 */

/** PostgREST's "no rows matched" code, which `.single()` returns for a student who has not started. */
export const NO_ROWS_ERROR_CODE = "PGRST116";

/**
 * What the server says about the student's response row.
 *
 * `unknown` is not pessimism for its own sake: under the write rules below a wrong guess in
 * either direction corrupts the row -- guessing `draft` downgrades a submission, guessing
 * `submitted` marks an unfinished draft complete -- so an unreadable row is a state in which
 * autosave must not write at all.
 */
export type LoadedResponseState = "submitted" | "draft" | "unknown";

export type LoadedSurveyResponseRow = { is_submitted?: boolean | null } | null;

export type LoadedSurveyResponseError = { code?: string | null } | null;

/**
 * Classify the response row fetched on page load, so the write rules are armed before the
 * form can be edited rather than only after a submit made in this session.
 *
 * A student who has never started (`NO_ROWS_ERROR_CODE`) is a `draft`: autosave inserts.
 */
export function responseStateFromLoad(result: {
  data?: LoadedSurveyResponseRow;
  error?: LoadedSurveyResponseError;
}): LoadedResponseState {
  const { data, error } = result;
  if (error && error.code !== NO_ROWS_ERROR_CODE) return "unknown";
  return data?.is_submitted ? "submitted" : "draft";
}

export type ResponseWriteFlags = {
  /** Drop the write entirely: the row's state is unreadable, so neither flag is safe. */
  skip: boolean;
  /** Value for the `is_submitted` column. */
  isSubmitted: boolean;
  /** Whether to include `submitted_at` in the upsert. Omitting it preserves the stored one. */
  stampSubmittedAt: boolean;
};

/**
 * Decide what a write to `survey_responses` carries.
 *
 * `isSubmitted` is the caller's intent: true for a Complete, false for the debounced autosave.
 *
 * - A Complete always goes through and always stamps `submitted_at`, including a re-submit of
 *   an already-submitted response, and including one made after a failed load.
 * - An autosave on an already-submitted response stays submitted and does NOT stamp
 *   `submitted_at`. The upsert only writes the columns it includes, so the original
 *   submission time survives. That is what keeps the edit *and* the invariant.
 * - An autosave on a draft writes a draft, as before.
 * - An autosave against an unreadable row is skipped.
 */
export function resolveResponseWriteFlags(args: {
  isSubmitted: boolean;
  loadedState: LoadedResponseState;
}): ResponseWriteFlags {
  if (args.isSubmitted) return { skip: false, isSubmitted: true, stampSubmittedAt: true };
  if (args.loadedState === "unknown") return { skip: true, isSubmitted: false, stampSubmittedAt: false };
  return { skip: false, isSubmitted: args.loadedState === "submitted", stampSubmittedAt: false };
}

/**
 * Whether the survey form renders read-only.
 *
 * A submitted response locks only when the survey does not allow editing; on an editable
 * survey the student may change answers and press Complete again. An instructor viewing as a
 * student is always read-only and must not overwrite the student's response.
 */
export function isSurveyResponseReadOnly(args: {
  responseIsSubmitted: boolean;
  allowResponseEditing: boolean;
  isViewingAsStudent: boolean;
}): boolean {
  return (args.responseIsSubmitted && !args.allowResponseEditing) || args.isViewingAsStudent;
}
