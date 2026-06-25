/* eslint-disable @typescript-eslint/no-explicit-any */
import { submissionReview } from "./fixtures";
export function useSubmissionReview(): any { return submissionReview; }
export function useActiveSubmissionReview(): any { return submissionReview; }
export function useDefaultWritableSubmissionReview(): any { return submissionReview; }
export function useWritableSubmissionReviews(): any[] { return [submissionReview]; }
export function useActiveRubricId(): any {
  return { activeRubricId: 1, setActiveRubricId: () => {}, scrollToRubricId: undefined, setScrollToRubricId: () => {} };
}
export function useActiveSubmissionReviewId(): any { return 1; }
export function useSetActiveSubmissionReviewId(): any { return () => {}; }
export function useActiveReviewAssignment(): any { return undefined; }
export function useActiveReviewAssignmentId(): any { return undefined; }
export function useIgnoreAssignedReview(): boolean { return false; }
export function useSetIgnoreAssignedReview(): any { return () => {}; }
export function useMissingRubricChecksForActiveReview(): any[] { return []; }
