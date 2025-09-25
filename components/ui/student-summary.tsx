"use client";
import { Icon } from "@chakra-ui/react";
import { BsPerson } from "react-icons/bs";
import Link from "./link";
export default function StudentSummaryTrigger({ student_id, course_id }: { student_id: string; course_id: number }) {
  return (
    <Link
      href={`/course/${course_id}/manage/student/${encodeURIComponent(student_id)}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open student ${student_id} in new tab`}
    >
      <Icon as={BsPerson} />
    </Link>
  );
}
