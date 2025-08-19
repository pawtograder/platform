import { usePathname, useRouter, useSearchParams } from "next/navigation";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAssignmentController, useMyReviewAssignments, useReviewAssignment, useRubricById } from "./useAssignment";
import {
  useAllCommentsForReview,
  useSubmission,
  useSubmissionReviewOrGradingReview,
  useWritableSubmissionReviews
} from "./useSubmission";

export type SubmissionReviewContextType = {
  activeReviewAssignmentId: number | undefined;
  setActiveReviewAssignmentId: (id: number | undefined) => void;
  activeSubmissionReviewId: number | undefined;
  setActiveSubmissionReviewId: (id: number | undefined) => void;
  activeRubricId: number | undefined;
  setActiveRubricId: (id: number | undefined) => void;
  scrollToRubricId: number | undefined;
  setScrollToRubricId: (id: number | undefined) => void;
  ignoreAssignedReview: number | undefined;
  setIgnoreAssignedReview: (ignore: number | undefined) => void;
};

const SubmissionReviewContext = createContext<SubmissionReviewContextType | undefined>(undefined);

export function useActiveRubricId() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) throw new Error("useActiveRubricId must be used within a SubmissionReviewProvider");
  return {
    activeRubricId: ctx.activeRubricId,
    setActiveRubricId: ctx.setActiveRubricId,
    scrollToRubricId: ctx.scrollToRubricId,
    setScrollToRubricId: ctx.setScrollToRubricId
  };
}

export function SubmissionReviewProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ignoreAssignedReview, setIgnoreAssignedReviewState] = useState<number | undefined>(undefined);
  const [activeReviewAssignmentId, setActiveReviewAssignmentIdState] = useState<number | undefined>(undefined);
  const [activeRubricId, setActiveRubricId] = useState<number | undefined>(undefined);
  const [scrollToRubricId, setScrollToRubricId] = useState<number | undefined>(undefined);
  const searchParams = useSearchParams();
  const reviewAssignmentIdParam = searchParams.get("review_assignment_id");
  const myAssignedReviews = useMyReviewAssignments();
  const writableReviews = useWritableSubmissionReviews();
  const submission = useSubmission();
  const assignmentController = useAssignmentController();
  const initialSubmissionReviewId = submission.grading_review_id ?? undefined;
  const [activeSubmissionReviewId, setActiveSubmissionReviewIdState] = useState<number | undefined>(
    initialSubmissionReviewId
  );

  // Helper: push updated review_assignment_id to URL (preserve other params)
  const navigateToReviewAssignmentId = (id: number | undefined) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id === undefined || id === null) {
      params.delete("review_assignment_id");
    } else {
      params.set("review_assignment_id", String(id));
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  useEffect(() => {
    // 1) If user chose to ignore the assigned review, do not bind to any review assignment.
    if (ignoreAssignedReview) {
      setActiveReviewAssignmentIdState(undefined);
      // Keep the currently selected submission review if any; if none, fall back once.
      if (!activeSubmissionReviewId) {
        const gradingWritable = writableReviews?.find((wr) => wr.id === submission.grading_review_id);
        const chosen = gradingWritable ?? writableReviews?.[0];
        if (chosen) {
          setActiveSubmissionReviewIdState(chosen.id);
          setActiveRubricId(chosen.rubric_id);
        } else {
          // last resort: non-writable grading review context
          setActiveSubmissionReviewIdState(submission.grading_review_id ?? undefined);
          setActiveRubricId(assignmentController.assignment.grading_rubric_id ?? undefined);
        }
      }
      return;
    }

    // 2) If a review_assignment_id is explicitly in the URL, it is the source of truth.
    const reviewAssignmentFromUrl = reviewAssignmentIdParam
      ? myAssignedReviews.find((ra) => ra.id === parseInt(reviewAssignmentIdParam, 10))
      : undefined;
    const writableForUrl = writableReviews?.find((wr) => wr.id === reviewAssignmentFromUrl?.submission_review_id);

    if (
      reviewAssignmentFromUrl &&
      writableForUrl &&
      !writableForUrl.completed_at &&
      !reviewAssignmentFromUrl.completed_at
    ) {
      setActiveReviewAssignmentIdState(reviewAssignmentFromUrl.id);
      setActiveSubmissionReviewIdState(reviewAssignmentFromUrl.submission_review_id);
      setActiveRubricId(reviewAssignmentFromUrl.rubric_id);
      return;
    }

    // 3) Otherwise, respect the user's explicit review selection (segment control) if present.
    if (activeSubmissionReviewId) {
      const selectedWritable = writableReviews?.find((wr) => wr.id === activeSubmissionReviewId);
      if (selectedWritable) {
        setActiveRubricId(selectedWritable.rubric_id);
      } else if (submission.grading_review_id === activeSubmissionReviewId) {
        setActiveRubricId(assignmentController.assignment.grading_rubric_id ?? undefined);
      }
      const raForSelected = myAssignedReviews.find(
        (ra) => ra.submission_review_id === activeSubmissionReviewId && !ra.completed_at
      );
      setActiveReviewAssignmentIdState(raForSelected?.id);
      return;
    }

    // 4) Initial/default selection when nothing is chosen and no URL param.
    if (writableReviews && writableReviews.length > 0) {
      const grading = writableReviews.find((wr) => wr.id === submission.grading_review_id);
      const chosen = grading ?? writableReviews[0];
      setActiveSubmissionReviewIdState(chosen.id);
      setActiveRubricId(chosen.rubric_id);
      const raDefault = myAssignedReviews.find((ra) => ra.submission_review_id === chosen.id && !ra.completed_at);
      setActiveReviewAssignmentIdState(raDefault?.id);
    } else {
      // default to non-writable grading review context
      setActiveReviewAssignmentIdState(undefined);
      setActiveSubmissionReviewIdState(submission.grading_review_id ?? undefined);
      setActiveRubricId(assignmentController.assignment.grading_rubric_id ?? undefined);
    }
  }, [
    reviewAssignmentIdParam,
    activeSubmissionReviewId,
    myAssignedReviews,
    writableReviews,
    submission,
    assignmentController,
    ignoreAssignedReview
  ]);

  // Wrapped setters that also sync the URL for consistency
  const setActiveReviewAssignmentId = (id: number | undefined) => {
    setActiveReviewAssignmentIdState(id);
    navigateToReviewAssignmentId(id);
  };

  const setActiveSubmissionReviewId = (id: number | undefined) => {
    setActiveSubmissionReviewIdState(id);
    // Map submission review -> review assignment (if any)
    const ra = id ? myAssignedReviews.find((r) => r.submission_review_id === id) : undefined;
    // Clear ignore state when explicitly selecting a review
    setIgnoreAssignedReviewState(undefined);
    navigateToReviewAssignmentId(ra?.id);
  };

  const setIgnoreAssignedReview = (ignore: number | undefined) => {
    // When ignoring, drop the param; when returning, restore the last ignored RA id
    if (ignore !== undefined) {
      navigateToReviewAssignmentId(undefined);
      setIgnoreAssignedReviewState(ignore);
    } else {
      // restore the previously ignored id (if any)
      navigateToReviewAssignmentId(ignoreAssignedReview);
      setIgnoreAssignedReviewState(undefined);
    }
  };

  const value = {
    activeReviewAssignmentId,
    setActiveReviewAssignmentId,
    activeSubmissionReviewId,
    setActiveSubmissionReviewId,
    activeRubricId,
    setActiveRubricId,
    scrollToRubricId,
    setScrollToRubricId,
    ignoreAssignedReview,
    setIgnoreAssignedReview
  };

  return <SubmissionReviewContext.Provider value={value}>{children}</SubmissionReviewContext.Provider>;
}

export function useMissingRubricChecksForActiveReview() {
  const activeSubmissionReview = useActiveSubmissionReview();
  if (!activeSubmissionReview) {
    throw new Error("No active submission review found");
  }
  const comments = useAllCommentsForReview(activeSubmissionReview?.id);
  const rubric = useRubricById(activeSubmissionReview.rubric_id);
  const rubricChecks = useMemo(() => {
    return rubric?.rubric_parts.flatMap((part) => part.rubric_criteria.flatMap((criteria) => criteria.rubric_checks));
  }, [rubric]);
  const { missing_required_checks, missing_optional_checks } = useMemo(() => {
    return {
      missing_required_checks: rubricChecks?.filter(
        (check) => check.is_required && !comments.some((comment) => comment.rubric_check_id === check.id)
      ),
      missing_optional_checks: rubricChecks?.filter(
        (check) => !check.is_required && !comments.some((comment) => comment.rubric_check_id === check.id)
      )
    };
  }, [rubricChecks, comments]);
  const { missing_required_criteria, missing_optional_criteria } = useMemo(() => {
    const allCriteria = rubric?.rubric_parts.flatMap((part) => part.rubric_criteria);
    const criteriaEvaluation = allCriteria?.map((criteria) => ({
      criteria,
      check_count_applied: criteria.rubric_checks.filter((check) =>
        comments.some((comment) => comment.rubric_check_id === check.id)
      ).length
    }));
    return {
      missing_required_criteria: criteriaEvaluation?.filter(
        (item) =>
          item.criteria.min_checks_per_submission !== null &&
          item.check_count_applied < item.criteria.min_checks_per_submission
      ),
      missing_optional_criteria: criteriaEvaluation?.filter(
        (item) => item.criteria.min_checks_per_submission === null && item.check_count_applied === 0
      )
    };
  }, [comments, rubric]);
  return { missing_required_checks, missing_optional_checks, missing_required_criteria, missing_optional_criteria };
}

export function useActiveSubmissionReview() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) throw new Error("useActiveSubmissionReview must be used within a SubmissionReviewProvider");
  if (!ctx.activeSubmissionReviewId) {
    throw new Error("No active submission review ID found");
  }
  return useSubmissionReviewOrGradingReview(ctx.activeSubmissionReviewId);
}
export function useActiveReviewAssignmentId() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) return undefined;
  return ctx.activeReviewAssignmentId;
}

export function useActiveReviewAssignment() {
  const ctx = useContext(SubmissionReviewContext);
  return useReviewAssignment(ctx?.activeReviewAssignmentId);
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

export function useIgnoreAssignedReview() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) throw new Error("useIgnoreAssignedReview must be used within a SubmissionReviewProvider");
  return ctx.ignoreAssignedReview;
}

export function useSetIgnoreAssignedReview() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) throw new Error("useSetIgnoreAssignedReview must be used within a SubmissionReviewProvider");
  return ctx.setIgnoreAssignedReview;
}
