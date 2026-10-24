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
// The real hook returns an OBJECT. Returning `[]` made every destructured field `undefined`, which
// the old truthiness guard in submission-review-toolbar.tsx happened to absorb; that guard is now
// `gradeTargetsBlocked`, so `missing_required_checks.length` would throw in the preview build.
export function useMissingRubricChecksForActiveReview(): any {
  return {
    missing_required_checks: [],
    missing_optional_checks: [],
    missing_required_criteria: [],
    missing_optional_criteria: [],
    gradeTargetsBlocked: false,
    // Paired with gradeTargetsBlocked: the toolbar reads both to tell "group still loading" from
    // "group settled and empty", and an undefined value here would render the preview's Complete
    // Review button as a permanent spinner.
    gradeTargetsLoaded: true
  };
}
