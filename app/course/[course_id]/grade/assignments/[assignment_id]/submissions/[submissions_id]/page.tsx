"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export default function SubmissionsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { course_id, assignment_id, submissions_id } = useParams();

  useEffect(() => {
    // Preserve existing query parameters when redirecting
    const queryString = searchParams.toString();
    const redirectUrl = `/course/${course_id}/manage/assignments/${assignment_id}/grade/${submissions_id}/results${
      queryString ? `?${queryString}` : ""
    }`;
    router.replace(redirectUrl);
  }, [router, course_id, assignment_id, submissions_id, searchParams]);

  return <div></div>;
}
