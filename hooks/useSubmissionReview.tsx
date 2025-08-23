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
  ignoreAssignedReview: boolean;
  setIgnoreAssignedReview: (ignore: boolean) => void;
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
  const searchParams = useSearchParams();
  const myAssignedReviews = useMyReviewAssignments();
  const writableReviews = useWritableSubmissionReviews();
  const submission = useSubmission();
  const assignmentController = useAssignmentController();
  const [scrollToRubricId, setScrollToRubricId] = useState<number | undefined>(undefined);

  const reviewAssignmentIdParam = searchParams.get("review_assignment_id");
  const selectedReviewIdParam = searchParams.get("selected_review_id");
  const ignoreReviewParam = searchParams.get("ignore_review") === "true";
  const selectedRubricIdParam = searchParams.get("selected_rubric_id");

  const activeReviewAssignmentId: number | undefined = useMemo(() => {
    if (ignoreReviewParam) return undefined;
    const id = reviewAssignmentIdParam ? parseInt(reviewAssignmentIdParam, 10) : undefined;
    return Number.isFinite(id as number) ? (id as number) : undefined;
  }, [ignoreReviewParam, reviewAssignmentIdParam]);

  // Validate URL params and clean up if they reference invalid entities
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    let changed = false;

    // Validate review_assignment_id
    if (activeReviewAssignmentId) {
      const exists = myAssignedReviews.some((ra) => ra.id === activeReviewAssignmentId);
      if (!exists) {
        params.delete("review_assignment_id");
        changed = true;
      }
    }

    // Validate selected_review_id
    if (selectedReviewIdParam) {
      const selectedId = parseInt(selectedReviewIdParam, 10);
      const validReviewIds = writableReviews?.map((wr) => wr.id) || [];
      // Also include grading review id if present
      if (submission.grading_review_id) validReviewIds.push(submission.grading_review_id);
      if (!validReviewIds.includes(selectedId)) {
        params.delete("selected_review_id");
        changed = true;
      }
    }

    if (changed) {
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }
  }, [
    activeReviewAssignmentId,
    selectedReviewIdParam,
    myAssignedReviews,
    writableReviews,
    submission.grading_review_id,
    searchParams,
    pathname,
    router
  ]);

  // Derive activeSubmissionReviewId primarily from URL, then RA, then defaults
  const activeSubmissionReviewId: number | undefined = useMemo(() => {
    if (selectedReviewIdParam) {
      const id = parseInt(selectedReviewIdParam, 10);
      return Number.isFinite(id) ? id : undefined;
    }
    if (activeReviewAssignmentId) {
      const ra = myAssignedReviews.find((r) => r.id === activeReviewAssignmentId);
      return ra?.submission_review_id ?? undefined;
    }
    // Fallbacks
    const gradingWritable = writableReviews?.find((wr) => wr.id === submission.grading_review_id);
    if (gradingWritable) return gradingWritable.id;
    return writableReviews && writableReviews.length > 0
      ? writableReviews[0].id
      : (submission.grading_review_id ?? undefined);
  }, [
    selectedReviewIdParam,
    activeReviewAssignmentId,
    myAssignedReviews,
    writableReviews,
    submission.grading_review_id
  ]);

  // Derive activeRubricId
  const activeRubricId: number | undefined = useMemo(() => {
    if (selectedRubricIdParam) {
      const id = parseInt(selectedRubricIdParam, 10);
      if (Number.isFinite(id)) return id;
    }
    if (activeReviewAssignmentId) {
      const ra = myAssignedReviews.find((r) => r.id === activeReviewAssignmentId);
      if (ra?.rubric_id) return ra.rubric_id;
    }
    if (activeSubmissionReviewId) {
      const wr = writableReviews?.find((r) => r.id === activeSubmissionReviewId);
      if (wr?.rubric_id) return wr.rubric_id;
    }
    return assignmentController.assignment.grading_rubric_id ?? undefined;
  }, [
    selectedRubricIdParam,
    activeReviewAssignmentId,
    myAssignedReviews,
    activeSubmissionReviewId,
    writableReviews,
    assignmentController.assignment.grading_rubric_id
  ]);

  // URL mutators
  const setActiveReviewAssignmentId = (id: number | undefined) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id === undefined || id === null) {
      params.delete("review_assignment_id");
    } else {
      params.set("review_assignment_id", String(id));
    }
    // When selecting a review assignment, clear ignore and selected_review_id to avoid conflicts
    params.delete("ignore_review");
    params.delete("selected_review_id");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const setActiveSubmissionReviewId = (id: number | undefined) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id === undefined || id === null) {
      params.delete("selected_review_id");
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
      return;
    }
    // If this review maps to an assigned, incomplete review, prefer RA in URL
    const ra = myAssignedReviews.find((r) => r.submission_review_id === id && !r.completed_at);
    if (ra) {
      params.set("review_assignment_id", String(ra.id));
      params.delete("selected_review_id");
      params.delete("ignore_review");
    } else {
      params.set("selected_review_id", String(id));
      // Only set ignore_review=true if there ARE assigned reviews that we're choosing to ignore
      const hasAssignedReviews = myAssignedReviews.length > 0;
      if (hasAssignedReviews) {
        params.set("ignore_review", "true");
      } else {
        params.delete("ignore_review");
      }
      params.delete("review_assignment_id");
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const setIgnoreAssignedReview = (ignore: boolean) => {
    const params = new URLSearchParams(searchParams.toString());
    if (ignore) {
      params.set("ignore_review", "true");
      params.delete("review_assignment_id");
    } else {
      params.delete("ignore_review");
      // If possible, restore to an incomplete assigned review for this submission
      const incomplete = myAssignedReviews.find((r) => !r.completed_at);
      if (incomplete) {
        params.set("review_assignment_id", String(incomplete.id));
        params.delete("selected_review_id");
      }
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const setActiveRubricId = (id: number | undefined) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id === undefined || id === null) {
      params.delete("selected_rubric_id");
    } else {
      params.set("selected_rubric_id", String(id));
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
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
    ignoreAssignedReview: ignoreReviewParam,
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
