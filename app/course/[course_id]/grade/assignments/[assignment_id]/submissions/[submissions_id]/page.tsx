"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

export default function SubmissionsView() {
  const router = useRouter();
  const { course_id, assignment_id, submissions_id } = useParams();
  useEffect(() => {
    router.replace(`/course/${course_id}/manage/assignments/${assignment_id}/grade/${submissions_id}/results`);
  }, [router, course_id, assignment_id, submissions_id]);
  return <div></div>;
}
