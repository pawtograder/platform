/** The fields of a review-dropdown row that picking the next review reads. */
export type NextReviewCandidate = {
  submissionId: number;
  /** The incomplete review assignment to open for this submission, if any. */
  reviewAssignmentId?: number;
  hasIncompleteReview: boolean;
  /** Every one of my incomplete review assignments on this submission, by id. */
  incompleteReviewAssignmentIds: number[];
};

/**
 * The review "Next Incomplete" and "Complete and go to next" open, or undefined when none is left.
 *
 * A grader with several assignments on one submission (one per rubric, say) finishes this submission
 * before moving on, so another incomplete assignment here comes first. The active one is excluded:
 * "Complete and go to next" reads this before its own completion lands. Otherwise, the first
 * incomplete submission after this one by id, wrapping around to the first incomplete one overall.
 */
export function pickNextIncompleteReview(
  options: NextReviewCandidate[],
  currentSubmissionId: number | undefined,
  activeReviewAssignmentId: number | undefined
): { submissionId: number; reviewAssignmentId?: number } | undefined {
  if (currentSubmissionId !== undefined) {
    const remainingHere = options
      .find((opt) => opt.submissionId === currentSubmissionId)
      ?.incompleteReviewAssignmentIds.find((id) => id !== activeReviewAssignmentId);
    if (remainingHere !== undefined) return { submissionId: currentSubmissionId, reviewAssignmentId: remainingHere };
  }
  const next =
    options.find(
      (opt) => opt.hasIncompleteReview && (currentSubmissionId === undefined || opt.submissionId > currentSubmissionId)
    ) || options.find((opt) => opt.hasIncompleteReview && opt.submissionId !== currentSubmissionId);
  return next ? { submissionId: next.submissionId, reviewAssignmentId: next.reviewAssignmentId } : undefined;
}
