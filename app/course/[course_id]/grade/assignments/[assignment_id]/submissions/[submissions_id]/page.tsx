"use client";

import { useSubmissionMaybe } from "@/hooks/useSubmission";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export default function SubmissionsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { course_id, assignment_id, submissions_id } = useParams();
  const submission = useSubmissionMaybe();
  const hasGraderTests = (submission?.grader_results?.grader_result_tests?.length ?? 0) > 0;

  useEffect(() => {
    if (!submission) {
      return;
    }

    // Preserve existing query parameters when redirecting
    const queryString = searchParams.toString();
    const targetPage = hasGraderTests ? "results" : "files";
    const redirectUrl = `/course/${course_id}/manage/assignments/${assignment_id}/grade/${submissions_id}/${targetPage}${
      queryString ? `?${queryString}` : ""
    }`;
    router.replace(redirectUrl);
  }, [router, course_id, assignment_id, submissions_id, searchParams, submission, hasGraderTests]);

  return <div></div>;
}
