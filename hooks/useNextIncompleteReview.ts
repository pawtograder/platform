"use client";

import { useMyReviewAssignments } from "@/hooks/useAssignment";
import { useParams } from "next/navigation";
import { useMemo } from "react";

/**
 * Returns the URL for the next incomplete review assignment, or null if all
 * reviews are complete or the user is not in review mode.
 *
 * Wraps around: if there is no incomplete review after the current submission,
 * it returns the first incomplete review overall.
 */
export function useNextIncompleteReviewUrl(): string | null {
  const { course_id, assignment_id, submissions_id } = useParams();
  const myReviewAssignments = useMyReviewAssignments();

  return useMemo(() => {
    if (myReviewAssignments.length === 0) return null;

    const bySubmission = new Map<number, typeof myReviewAssignments>();
    myReviewAssignments.forEach((ra) => {
      const existing = bySubmission.get(ra.submission_id) || [];
      bySubmission.set(ra.submission_id, [...existing, ra]);
    });

    const options = Array.from(bySubmission.entries())
      .map(([submissionId, assignments]) => ({
        submissionId,
        hasIncompleteReview: assignments.some((ra) => !ra.completed_at)
      }))
      .sort((a, b) => {
        if (a.hasIncompleteReview && !b.hasIncompleteReview) return -1;
        if (!a.hasIncompleteReview && b.hasIncompleteReview) return 1;
        return a.submissionId - b.submissionId;
      });

    const currentSubmissionId = submissions_id ? parseInt(submissions_id as string) : undefined;

    const nextOption =
      options.find(
        (opt) => opt.hasIncompleteReview && (!currentSubmissionId || opt.submissionId > currentSubmissionId)
      ) || options.find((opt) => opt.hasIncompleteReview);

    if (!nextOption) return null;

    const ras = bySubmission.get(nextOption.submissionId) ?? [];
    const target = ras.find((ra) => !ra.completed_at) ?? ras[0];
    if (!target) return null;

    return `/course/${course_id}/assignments/${assignment_id}/submissions/${target.submission_id}/files?review_assignment_id=${target.id}`;
  }, [myReviewAssignments, course_id, assignment_id, submissions_id]);
}
