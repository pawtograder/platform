/* eslint-disable @typescript-eslint/no-explicit-any */
import { mockTable } from "./_lib";
import {
  submission,
  submissionReview,
  submissionComments,
  submissionFileComments
} from "./fixtures";

const controller: any = {
  submission_comments: mockTable(submissionComments),
  submission_file_comments: mockTable(submissionFileComments),
  submission_artifact_comments: mockTable([]),
  submission_reviews: mockTable([submissionReview]),
  submission_regrade_request_comments: mockTable([]),
  submission,
  file: submission.submission_files[0],
  isReady: true,
  readyPromise: Promise.resolve()
};

export function useSubmission(): any { return submission; }
export function useSubmissionMaybe(): any { return submission; }
export function useSubmissionController(): any { return controller; }

export function useSubmissionFileComments(): any[] { return submissionFileComments; }
export function useSubmissionComment(): any { return submissionComments[0]; }
export function useSubmissionCommentByType(): any[] { return submissionComments; }
export function useSubmissionArtifactComment(): any { return undefined; }
export function useSubmissionFileComment(id?: any): any {
  return submissionFileComments.find((c) => c.id === id) ?? submissionFileComments[0];
}
export function useSubmissionRegradeRequestComments(): any[] { return []; }
export function useAllCommentsForReview(): any[] { return submissionComments; }

export function useRubricCheckInstances(check?: any): any[] {
  const id = check?.id ?? check;
  return submissionComments.filter((c) => c.rubric_check_id === id);
}
export function useRubricCriteriaInstances(): any[] { return []; }
export function useReferencedRubricCheckInstances(): any[] { return []; }

export function useSubmissionReview(): any { return submissionReview; }
export function useSubmissionReviewForRubric(): any { return submissionReview; }
export function useSubmissionReviewOrGradingReview(): any { return submissionReview; }
export function useWritableSubmissionReviews(): any[] { return [submissionReview]; }

// ── added safe defaults (repo-wide importers) ──
export function useSubmissionComments(): any[] { return submissionComments; }
export function useSubmissionArtifactComments(): any[] { return []; }
export function useRubricCheck(id?: any): any { return undefined; }
