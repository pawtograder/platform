export type BulkReleaseAction = "released" | "unreleased";

export type BulkReleaseMessage = {
  status: "success" | "warning";
  title: string;
  description: string;
};

/**
 * Phrase the outcome of a bulk grade release/unrelease from the RPC's actual `ROW_COUNT`.
 *
 * The toast used to report the number of SELECTED submissions, ignoring the count the RPC returns.
 * Select 40, release 12, get told "40 released" — and the twenty-eight that were skipped are never
 * mentioned again.
 *
 * Two things make the wording tricky:
 *
 *  1. The count is in SUBMISSION REVIEWS, not submissions. The RPC's UPDATE joins on submission_id
 *     with no rubric filter, and submission_reviews is unique per (submission_id, rubric_id), so a
 *     submission carrying a grading review plus a self-review contributes more than one. It can
 *     therefore legitimately EXCEED the number selected — which is why this must never be phrased
 *     as "N of M submissions".
 *  2. A partial result is usually correct, not an error: the RPC filters on `is_active` and on the
 *     review not already being in the target state, so re-clicking Release after adding two more
 *     submissions is the common case. Warning-toasting that would be noise.
 */
export function describeBulkReleaseResult({
  affected,
  selectedCount,
  action
}: {
  affected: number;
  selectedCount: number;
  action: BulkReleaseAction;
}): BulkReleaseMessage {
  const submissions = `${selectedCount} selected submission${selectedCount === 1 ? "" : "s"}`;

  if (affected === 0) {
    const already = action === "released" ? "already released" : "not released";
    // A green "Success" for a no-op is the same class of lie as reporting the selected count.
    return {
      status: "warning",
      title: action === "released" ? "Nothing to release" : "Nothing to unrelease",
      description:
        `No submission reviews changed. The ${submissions} ${selectedCount === 1 ? "was" : "were"} ` +
        `${already}, or ${selectedCount === 1 ? "has" : "have"} no active submission.`
    };
  }

  const reviews = `${affected} submission review${affected === 1 ? "" : "s"}`;
  return {
    status: "success",
    title: "Success",
    description: `${reviews} ${action} across ${submissions}.`
  };
}
