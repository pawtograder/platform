"use client";

import { useSubmissionMaybe } from "@/hooks/useSubmission";
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
  const { assignment } = useAssignmentController();
  // No-submission assignments have no files/autograder output, so those tabs don't exist. Land on Grade.
  const isNoSubmissionAssignment = assignment.repo_mode === "no_submission";

  useEffect(() => {
    if (!submission) {
      return;
    }

    // Preserve existing query parameters when redirecting
    const queryString = searchParams.toString();
    const targetPage = isNoSubmissionAssignment ? "grade" : hasGraderOutput ? "results" : "files";
    const redirectUrl = `/course/${course_id}/grade/assignments/${assignment_id}/submissions/${submissions_id}/${targetPage}${
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
    isNoSubmissionAssignment
  ]);

  return <div></div>;
}
