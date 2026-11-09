/** One of my incomplete review assignments. */
export type IncompleteReview = { id: number; submissionReviewId: number };

/** The fields of a review-dropdown row that picking the next review reads. */
export type NextReviewCandidate = {
  submissionId: number;
  /** The incomplete review assignment to open for this submission, if any. */
  reviewAssignmentId?: number;
  hasIncompleteReview: boolean;
  /** Every one of my incomplete review assignments on this submission, by id. */
  incompleteReviews: IncompleteReview[];
};

/** What is being completed right now, so the next review is never one this completion closes. */
export type CompletingNow = {
  /** The review assignment open on this page (it is the one being completed). */
  activeReviewAssignmentId?: number;
  /**
   * A submission review being marked complete. Completing it also completes every review assignment
   * on it (the complete_remaining_review_assignments trigger), so none of those can be next.
   */
  submissionReviewId?: number;
};

/**
 * The review "Next Incomplete" and "Complete and go to next" open, or undefined when none is left.
 *
 * A grader with several assignments on one submission (one per rubric, say) finishes this submission
 * before moving on, so another incomplete assignment here comes first. Assignments the current
 * completion closes are excluded: "Complete and go to next" reads this before its completion lands.
 * Otherwise, the first incomplete submission after this one by id, wrapping around to the first
 * incomplete one overall.
 */
export function pickNextIncompleteReview(
  options: NextReviewCandidate[],
  currentSubmissionId: number | undefined,
  completing: CompletingNow = {}
): { submissionId: number; reviewAssignmentId?: number } | undefined {
  if (currentSubmissionId !== undefined) {
    const remainingHere = options
      .find((opt) => opt.submissionId === currentSubmissionId)
      ?.incompleteReviews.find(
        (ra) => ra.id !== completing.activeReviewAssignmentId && ra.submissionReviewId !== completing.submissionReviewId
      );
    if (remainingHere) return { submissionId: currentSubmissionId, reviewAssignmentId: remainingHere.id };
  }
  const next =
    options.find(
      (opt) => opt.hasIncompleteReview && (currentSubmissionId === undefined || opt.submissionId > currentSubmissionId)
    ) || options.find((opt) => opt.hasIncompleteReview && opt.submissionId !== currentSubmissionId);
  return next ? { submissionId: next.submissionId, reviewAssignmentId: next.reviewAssignmentId } : undefined;
}
