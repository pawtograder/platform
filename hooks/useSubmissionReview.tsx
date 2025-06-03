import { useSearchParams } from "next/navigation";
import React, { createContext, useContext, useEffect, useState } from "react";
import { useMyReviewAssignments } from "./useAssignment";
import { useSubmission, useSubmissionReview, useWritableSubmissionReviews } from "./useSubmission";

export type SubmissionReviewContextType = {
  activeReviewAssignmentId: number | undefined;
  setActiveReviewAssignmentId: (id: number | undefined) => void;
  activeSubmissionReviewId: number | undefined;
  setActiveSubmissionReviewId: (id: number | undefined) => void;
};

const SubmissionReviewContext = createContext<SubmissionReviewContextType | undefined>(undefined);

export function SubmissionReviewProvider({ children }: { children: React.ReactNode }) {
  const [activeReviewAssignmentId, setActiveReviewAssignmentId] = useState<number | undefined>(undefined);
  const [activeSubmissionReviewId, setActiveSubmissionReviewId] = useState<number | undefined>(undefined);
  const searchParams = useSearchParams();
  const reviewAssignmentIdParam = searchParams.get("review_assignment_id");
  const myAssignedReviews = useMyReviewAssignments();
  const writableReviews = useWritableSubmissionReviews();
  const submission = useSubmission();

  useEffect(() => {
    const reviewAssignment = reviewAssignmentIdParam
      ? myAssignedReviews.find((ra) => ra.id === parseInt(reviewAssignmentIdParam, 10))
      : undefined;
    if (reviewAssignment) {
      setActiveReviewAssignmentId(reviewAssignment.id);
      setActiveSubmissionReviewId(reviewAssignment.submission_review_id);
    } else if (writableReviews && writableReviews.length > 0) {
      setActiveReviewAssignmentId(writableReviews[0].id);
      setActiveSubmissionReviewId(writableReviews[0].id);
    } else {
      //Default to grading review
      setActiveReviewAssignmentId(undefined);
      setActiveSubmissionReviewId(submission.grading_review_id ?? undefined);
    }
  }, [reviewAssignmentIdParam, setActiveReviewAssignmentId, myAssignedReviews, writableReviews, submission]);

  const value = {
    activeReviewAssignmentId,
    setActiveReviewAssignmentId,
    activeSubmissionReviewId,
    setActiveSubmissionReviewId
  };

  return <SubmissionReviewContext.Provider value={value}>{children}</SubmissionReviewContext.Provider>;
}

export function useActiveSubmissionReview() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) throw new Error("useActiveSubmissionReview must be used within a SubmissionReviewProvider");
  return useSubmissionReview(ctx.activeSubmissionReviewId);
}
export function useActiveReviewAssignmentId() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) throw new Error("useActiveReviewAssignmentId must be used within a SubmissionReviewProvider");
  return ctx.activeReviewAssignmentId;
}

export function useSetActiveReviewAssignmentId() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) throw new Error("useSetActiveReviewAssignmentId must be used within a SubmissionReviewProvider");
  return ctx.setActiveReviewAssignmentId;
}

export function useActiveSubmissionReviewId() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) throw new Error("useActiveSubmissionReviewId must be used within a SubmissionReviewProvider");
  return ctx.activeSubmissionReviewId;
}

export function useSetActiveSubmissionReviewId() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) throw new Error("useSetActiveSubmissionReviewId must be used within a SubmissionReviewProvider");
  return ctx.setActiveSubmissionReviewId;
}
