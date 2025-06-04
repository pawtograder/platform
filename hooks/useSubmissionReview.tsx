import { useSearchParams } from "next/navigation";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAssignmentController, useMyReviewAssignments, useReviewAssignment } from "./useAssignment";
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
    const [activeReviewAssignmentId, setActiveReviewAssignmentId] = useState<number | undefined>(undefined);
    const [activeSubmissionReviewId, setActiveSubmissionReviewId] = useState<number | undefined>(undefined);
    const [activeRubricId, setActiveRubricId] = useState<number | undefined>(undefined);
    const [scrollToRubricId, setScrollToRubricId] = useState<number | undefined>(undefined);
    const searchParams = useSearchParams();
    const reviewAssignmentIdParam = searchParams.get("review_assignment_id");
    const myAssignedReviews = useMyReviewAssignments();
    const writableReviews = useWritableSubmissionReviews();
    const submission = useSubmission();
    const assignmentController = useAssignmentController();

    useEffect(() => {
        const reviewAssignment = reviewAssignmentIdParam
            ? myAssignedReviews.find((ra) => ra.id === parseInt(reviewAssignmentIdParam, 10))
            : undefined;
        const assignedSubmissionReview = writableReviews?.find((wr) => wr.id === reviewAssignment?.submission_review_id);
        //If the review assignment has been completed, don't set it as active
        if (reviewAssignment && assignedSubmissionReview && !assignedSubmissionReview?.completed_at) {
            setActiveReviewAssignmentId(reviewAssignment.id);
            setActiveSubmissionReviewId(reviewAssignment.submission_review_id);
            setActiveRubricId(reviewAssignment.rubric_id);
        } else if (writableReviews && writableReviews.length > 0) {
            //Default to a grading review if it is writable
            const gradingReview = writableReviews.find((wr) => wr.rubrics.review_round === "grading-review");
            if (gradingReview) {
                setActiveReviewAssignmentId(myAssignedReviews.find((ra) => ra.submission_review_id === gradingReview.id)?.id);
                //Only set submission review id if it is writable!
                setActiveSubmissionReviewId(writableReviews.find((wr) => wr.id === gradingReview.id)?.id ?? undefined);
                setActiveRubricId(gradingReview.rubric_id);
            } else {
                setActiveReviewAssignmentId(
                    myAssignedReviews.find((ra) => ra.submission_review_id === writableReviews[0].id)?.id
                );
                setActiveSubmissionReviewId(writableReviews[0].id);
                setActiveRubricId(writableReviews[0].rubric_id);
            }
        } else {
            //Default to grading review
            setActiveReviewAssignmentId(undefined);
            setActiveSubmissionReviewId(undefined);
            setActiveRubricId(assignmentController.assignment.grading_rubric_id ?? undefined);
        }
    }, [
        reviewAssignmentIdParam,
        setActiveReviewAssignmentId,
        myAssignedReviews,
        writableReviews,
        submission,
        assignmentController
    ]);

    const value = {
        activeReviewAssignmentId,
        setActiveReviewAssignmentId,
        activeSubmissionReviewId,
        setActiveSubmissionReviewId,
        activeRubricId,
        setActiveRubricId,
        scrollToRubricId,
        setScrollToRubricId
    };

    return <SubmissionReviewContext.Provider value={value}>{children}</SubmissionReviewContext.Provider>;
}

export function useMissingRubricChecksForActiveReview() {
    const activeSubmissionReview = useActiveSubmissionReview();
    const comments = useAllCommentsForReview(activeSubmissionReview?.id);
    const rubricChecks = useMemo(() => {
        return activeSubmissionReview?.rubrics.rubric_parts.flatMap((part) =>
            part.rubric_criteria.flatMap((criteria) => criteria.rubric_checks)
        );
    }, [activeSubmissionReview]);
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
        const allCriteria = activeSubmissionReview?.rubrics.rubric_parts.flatMap((part) => part.rubric_criteria);
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
    }, [comments, activeSubmissionReview?.rubrics.rubric_parts]);
    return { missing_required_checks, missing_optional_checks, missing_required_criteria, missing_optional_criteria };
}

export function useActiveSubmissionReview() {
    const ctx = useContext(SubmissionReviewContext);
    if (!ctx) throw new Error("useActiveSubmissionReview must be used within a SubmissionReviewProvider");
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
