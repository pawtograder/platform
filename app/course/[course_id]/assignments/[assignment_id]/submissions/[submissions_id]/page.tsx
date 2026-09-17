"use client";

import { useSubmissionMaybe, useSubmissionReviewOrGradingReview } from "@/hooks/useSubmission";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useAssignmentController } from "@/hooks/useAssignment";
import { submissionHasGraderOutput } from "@/lib/submissionHasGraderOutput";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export default function SubmissionsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { course_id, assignment_id, submissions_id } = useParams();
  const submission = useSubmissionMaybe();
  const hasGraderOutput = submissionHasGraderOutput(submission?.grader_results);
  const gradingReview = useSubmissionReviewOrGradingReview(submission?.grading_review_id ?? undefined);
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const { assignment } = useAssignmentController();
  const released = gradingReview?.released ?? false;
  // No-submission assignments have no files/autograder output, so those tabs don't exist. Land on Grade.
  const isNoSubmissionAssignment = assignment.repo_mode === "no_submission";

  useEffect(() => {
    if (!submission) {
      return;
    }

    // Default landing tab: students land on the released grade summary if available; graders and
    // instructors (who work from the rubric sidebar) keep landing on autograder feedback / files.
    const queryString = searchParams.toString();
    const targetPage = isNoSubmissionAssignment
      ? "grade"
      : !isGraderOrInstructor && released
        ? "grade"
        : hasGraderOutput
          ? "results"
          : "files";
    const redirectUrl = `/course/${course_id}/assignments/${assignment_id}/submissions/${submissions_id}/${targetPage}${
      queryString ? `?${queryString}` : ""
    }`;
    router.replace(redirectUrl);
  }, [
    router,
    course_id,
    assignment_id,
    submissions_id,
    searchParams,
    submission,
    hasGraderOutput,
    released,
    isGraderOrInstructor,
    isNoSubmissionAssignment
  ]);

  return <div></div>;
}
