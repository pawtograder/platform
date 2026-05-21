"use client";

import { useSubmissionMaybe, useSubmissionReviewOrGradingReview } from "@/hooks/useSubmission";
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
  const released = gradingReview?.released ?? false;

  useEffect(() => {
    if (!submission) {
      return;
    }

    // Default landing tab: the released grade summary if available, otherwise autograder feedback
    // (visible before release), otherwise the files. Preserve existing query parameters.
    const queryString = searchParams.toString();
    const targetPage = released ? "grade" : hasGraderOutput ? "results" : "files";
    const redirectUrl = `/course/${course_id}/assignments/${assignment_id}/submissions/${submissions_id}/${targetPage}${
      queryString ? `?${queryString}` : ""
    }`;
    router.replace(redirectUrl);
  }, [router, course_id, assignment_id, submissions_id, searchParams, submission, hasGraderOutput, released]);

  return <div></div>;
}
