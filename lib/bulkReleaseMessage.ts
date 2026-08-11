export type BulkReleaseAction = "released" | "unreleased";

export type BulkReleaseMessage = {
  status: "success" | "warning";
  title: string;
  description: string;
};

/**
 * Both release RPCs scope their UPDATE to `submissions.grading_review_id`, so a bulk release never
 * touches the self-review or meta-grading rounds — releasing those publishes meta-grader comments
 * to students. Instructors cannot see that from the row count alone, so every success toast says it.
 */
const ROUNDS_UNCHANGED = "Self-review and meta-grading rounds were not changed.";

const noOpTitle = (action: BulkReleaseAction) =>
  action === "released" ? "Nothing to release" : "Nothing to unrelease";

/** How to describe a review that is already in the target state. */
const alreadyInTargetState = (action: BulkReleaseAction) =>
  action === "released" ? "already released" : "not released";

const pastVerb = (action: BulkReleaseAction) => (action === "released" ? "Released" : "Unreleased");

/**
 * Phrase the outcome of a bulk grade release/unrelease from the RPC's actual `ROW_COUNT`.
 *
 * The toast used to report the number of SELECTED submissions, ignoring the count the RPC returns.
 * Select 40, release 12, get told "40 released" — and the twenty-eight that were skipped are never
 * mentioned again.
 *
 * Two things make the wording tricky:
 *
 *  1. `affected` counts submission_reviews rows, but the RPC scopes its UPDATE to the grading
 *     review (`submission_reviews.id = submissions.grading_review_id`), so there is at most one
 *     per selected submission. The count is therefore always <= the number selected, and
 *     "N of M submissions" is exact. It used to join on submission_id alone and could report MORE
 *     reviews than submissions selected; see
 *     `supabase/migrations/20260811130000_release_grading_review_only.sql`.
 *  2. A partial result is usually correct, not an error: the RPC filters on `is_active` and on the
 *     grading review not already being in the target state, so re-clicking Release after adding two
 *     more submissions is the common case. Warning-toasting that would be noise.
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
    // A green "Success" for a no-op is the same class of lie as reporting the selected count.
    return {
      status: "warning",
      title: noOpTitle(action),
      description:
        `No grading reviews changed. The ${submissions} ${selectedCount === 1 ? "was" : "were"} ` +
        `${alreadyInTargetState(action)}, or ${selectedCount === 1 ? "has" : "have"} no active submission ` +
        `with a grading review.`
    };
  }

  return {
    status: "success",
    title: "Success",
    description: `${pastVerb(action)} the grading review for ${affected} of ${submissions}. ${ROUNDS_UNCHANGED}`
  };
}

/**
 * Same wording rules as {@link describeBulkReleaseResult}, for the assignment-wide
 * "Release all" / "Unrelease all" RPCs.
 *
 * There is no denominator here on purpose. The panel's `Graded x/y` counters come from the
 * dashboard rows, which are per student (a group submission appears once per member) and include
 * students with no submission at all, so pairing the RPC's count against that total would produce
 * a ratio that does not mean anything. Report the count the RPC returned and nothing more.
 */
export function describeReleaseAllResult({
  affected,
  action
}: {
  affected: number;
  action: BulkReleaseAction;
}): BulkReleaseMessage {
  if (affected === 0) {
    return {
      status: "warning",
      title: noOpTitle(action),
      description:
        `No grading reviews changed. Every submission in this assignment was ` +
        `${alreadyInTargetState(action)}, or has no active submission with a grading review.`
    };
  }

  const submissions = `${affected} submission${affected === 1 ? "" : "s"}`;
  return {
    status: "success",
    title: "Success",
    description: `${pastVerb(action)} the grading review for ${submissions} in this assignment. ${ROUNDS_UNCHANGED}`
  };
}
