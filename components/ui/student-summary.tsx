"use client";
import { Icon } from "@chakra-ui/react";
import { BsPerson } from "react-icons/bs";
import Link from "./link";
export default function StudentSummaryTrigger({ student_id, course_id }: { student_id: string; course_id: number }) {
  return (
    <Link href={`/course/${course_id}/manage/student/${student_id}`} target="_blank">
      <Icon as={BsPerson} />
    </Link>
  );
}
