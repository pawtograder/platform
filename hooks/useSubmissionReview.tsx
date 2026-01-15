import { usePathname, useRouter, useSearchParams } from "next/navigation";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  useAssignmentController,
  useMyReviewAssignments,
  useReviewAssignment,
  useRubricChecksByRubric,
  useRubricCriteriaByRubric
} from "./useAssignment";
import {
  useAllCommentsForReview,
  useSubmission,
  useSubmissionReviewOrGradingReview,
  useWritableSubmissionReviews
} from "./useSubmission";
import { useNavigationProgress } from "@/components/ui/navigation-progress";

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
  const submission = useSubmission();
  const myAssignedReviews = useMyReviewAssignments(submission?.id);
  const writableReviews = useWritableSubmissionReviews();
  const assignmentController = useAssignmentController();
  const [scrollToRubricId, setScrollToRubricId] = useState<number | undefined>(undefined);
  const [clientActiveRubricId, setClientActiveRubricId] = useState<number | undefined>(undefined);
  const { startNavigation } = useNavigationProgress();

  const reviewAssignmentIdParam = searchParams.get("review_assignment_id");
  const selectedReviewIdParam = searchParams.get("selected_review_id");
  const ignoreReviewParam = searchParams.get("ignore_review") === "true";
  const selectedRubricIdParam = searchParams.get("selected_rubric_id");

  const activeReviewAssignmentId: number | undefined = useMemo(() => {
    if (ignoreReviewParam) return undefined;

    // If there's a URL parameter, use it
    if (reviewAssignmentIdParam) {
      const id = parseInt(reviewAssignmentIdParam, 10);
      return Number.isFinite(id) ? id : undefined;
    }

    // If no URL parameter, automatically select an incomplete review assignment
    const incompleteReviewAssignment = myAssignedReviews.find((ra) => !ra.completed_at);
    return incompleteReviewAssignment?.id;
  }, [ignoreReviewParam, reviewAssignmentIdParam, myAssignedReviews]);

  // Validate URL params and clean up if they reference invalid entities
  useEffect(() => {
    // Don't validate URLs until the assignment controller is ready and data has loaded
    if (!assignmentController.isReady) {
      return;
    }

    // Note: We allow validation to proceed even when myAssignedReviews.length === 0
    // This ensures invalid review_assignment_id values are cleaned up even when
    // the user truly has zero assignments, preventing permanent URL pollution

    const params = new URLSearchParams(searchParams.toString());
    let changed = false;

    // Validate review_assignment_id
    if (activeReviewAssignmentId) {
      const exists = myAssignedReviews.some((ra) => ra.id === activeReviewAssignmentId);
      if (!exists) {
        params.delete("review_assignment_id");
        changed = true;
      } else {
        // If we have an active review assignment but no URL parameter for it,
        // add it to the URL to ensure the state is properly reflected
        if (!reviewAssignmentIdParam && !ignoreReviewParam) {
          params.set("review_assignment_id", String(activeReviewAssignmentId));
          changed = true;
        }
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

    // Validate selected_rubric_id
    if (selectedRubricIdParam) {
      const selectedRubricId = parseInt(selectedRubricIdParam, 10);
      if (Number.isFinite(selectedRubricId)) {
        const validRubricIds = [];
        // Add rubric IDs from review assignments
        myAssignedReviews.forEach((ra) => {
          if (ra.rubric_id) validRubricIds.push(ra.rubric_id);
        });
        // Add rubric IDs from writable reviews
        writableReviews?.forEach((wr) => {
          if (wr.rubric_id) validRubricIds.push(wr.rubric_id);
        });
        // Add assignment's grading rubric ID
        if (assignmentController.assignment.grading_rubric_id) {
          validRubricIds.push(assignmentController.assignment.grading_rubric_id);
        }
        // Remove duplicates
        const uniqueValidRubricIds = [...new Set(validRubricIds)];
        if (!uniqueValidRubricIds.includes(selectedRubricId)) {
          params.delete("selected_rubric_id");
          changed = true;
        }
      }
    }

    if (changed) {
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }
  }, [
    activeReviewAssignmentId,
    selectedReviewIdParam,
    selectedRubricIdParam,
    myAssignedReviews,
    writableReviews,
    submission.grading_review_id,
    assignmentController.assignment.grading_rubric_id,
    assignmentController.isReady,
    searchParams,
    pathname,
    router,
    reviewAssignmentIdParam,
    ignoreReviewParam
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

  // Derive activeRubricId - prioritize client state, then URL param, then defaults
  const activeRubricId: number | undefined = useMemo(() => {
    // If we have client state, use that
    if (clientActiveRubricId !== undefined) {
      return clientActiveRubricId;
    }

    // Otherwise fall back to URL param if specified
    if (selectedRubricIdParam) {
      const id = parseInt(selectedRubricIdParam, 10);
      if (Number.isFinite(id)) return id;
    }

    // Then fall back to defaults based on context
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
    clientActiveRubricId,
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
    startNavigation();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const setActiveSubmissionReviewId = (id: number | undefined) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id === undefined || id === null) {
      params.delete("selected_review_id");
      const qs = params.toString();
      startNavigation();
      router.push(qs ? `${pathname}?${qs}` : pathname);
      return;
    }

    // Validate that the submission review belongs to the current submission
    const validReviewIds = writableReviews?.map((wr) => wr.id) || [];
    if (submission.grading_review_id) validReviewIds.push(submission.grading_review_id);
    if (!validReviewIds.includes(id)) {
      // Invalid review ID for current submission - don't navigate
      return;
    }

    // If this review maps to an assigned, incomplete review, prefer RA in URL
    const ra = myAssignedReviews.find((r) => r.submission_review_id === id && !r.completed_at);
    if (ra) {
      // Double-check: ensure this review assignment actually belongs to current submission
      // (myAssignedReviews is already scoped to submission, but be explicit)
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
    startNavigation();
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
    startNavigation();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  // Simple React state setter - no URL manipulation
  const setActiveRubricId = (id: number | undefined) => {
    setClientActiveRubricId(id);
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
  const comments = useAllCommentsForReview(activeSubmissionReview?.id);

  // Get rubric data using hooks filtered by rubric_id
  const rubricChecks = useRubricChecksByRubric(activeSubmissionReview?.rubric_id);
  const allCriteria = useRubricCriteriaByRubric(activeSubmissionReview?.rubric_id);

  const { missing_required_checks, missing_optional_checks } = useMemo(() => {
    if (!activeSubmissionReview || !rubricChecks.length) {
      return { missing_required_checks: [], missing_optional_checks: [] };
    }

    // Calculate criteria evaluation for saturation check
    const criteriaEvaluation = allCriteria.map((criteria) => {
      const checksForCriteria = rubricChecks.filter((check) => check.rubric_criteria_id === criteria.id);
      const check_count_applied = checksForCriteria.filter((check) =>
        comments.some((comment) => comment.rubric_check_id === check.id)
      ).length;

      return {
        criteria,
        check_count_applied
      };
    });

    const saturatedCriteria = criteriaEvaluation.filter(
      (item) => item.criteria.max_checks_per_submission === item.check_count_applied
    );

    return {
      missing_required_checks: rubricChecks.filter(
        (check) => check.is_required && !comments.some((comment) => comment.rubric_check_id === check.id)
      ),
      missing_optional_checks: rubricChecks.filter(
        (check) =>
          !check.is_required &&
          !comments.some((comment) => comment.rubric_check_id === check.id) &&
          !saturatedCriteria.some((item) => item.criteria.id === check.rubric_criteria_id)
      )
    };
  }, [rubricChecks, comments, activeSubmissionReview, allCriteria]);

  const { missing_required_criteria, missing_optional_criteria } = useMemo(() => {
    if (!activeSubmissionReview || !allCriteria.length) {
      return { missing_required_criteria: [], missing_optional_criteria: [] };
    }

    const criteriaEvaluation = allCriteria.map((criteria) => {
      const checksForCriteria = rubricChecks.filter((check) => check.rubric_criteria_id === criteria.id);
      const check_count_applied = checksForCriteria.filter((check) =>
        comments.some((comment) => comment.rubric_check_id === check.id)
      ).length;

      return {
        criteria,
        check_count_applied
      };
    });

    return {
      missing_required_criteria: criteriaEvaluation.filter(
        (item) =>
          item.criteria.min_checks_per_submission !== null &&
          item.check_count_applied < item.criteria.min_checks_per_submission
      ),
      missing_optional_criteria: criteriaEvaluation.filter(
        (item) => item.criteria.min_checks_per_submission === null && item.check_count_applied === 0
      )
    };
  }, [comments, allCriteria, rubricChecks, activeSubmissionReview]);

  return { missing_required_checks, missing_optional_checks, missing_required_criteria, missing_optional_criteria };
}

export function useActiveSubmissionReview() {
  const ctx = useContext(SubmissionReviewContext);
  if (!ctx) throw new Error("useActiveSubmissionReview must be used within a SubmissionReviewProvider");

  // Check if we're still loading data that could affect activeSubmissionReviewId
  const submission = useSubmission();
  const myAssignedReviews = useMyReviewAssignments(submission?.id);
  const assignmentController = useAssignmentController();

  // Always call the hook to avoid conditional hook calls
  const submissionReview = useSubmissionReviewOrGradingReview(ctx.activeSubmissionReviewId || -1);

  // If we have an activeReviewAssignmentId but no activeSubmissionReviewId,
  // we might still be loading the review assignment data
  const isLoadingReviewAssignment = !!(
    ctx.activeReviewAssignmentId && !myAssignedReviews.find((ra) => ra.id === ctx.activeReviewAssignmentId)
  );

  // If we don't have an activeSubmissionReviewId and we're potentially still loading,
  // return undefined instead of throwing an error
  if (!ctx.activeSubmissionReviewId) {
    if (isLoadingReviewAssignment || !assignmentController.isReady) {
      return undefined; // Still loading, don't throw error
    }
    throw new Error("No active submission review ID found");
  }

  return submissionReview;
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
