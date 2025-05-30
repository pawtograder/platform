"use client";

import Link from "@/components/ui/link";
import { HStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";

export default function AssignmentGradingToolbar() {
  const { course_id, assignment_id } = useParams();
  //Future home of grading toolbar
  return (
    <HStack>
      <Link colorPalette="green" href={`/course/${course_id}/manage/assignments/${assignment_id}`}>
        Assignment Home
      </Link>
    </HStack>
  );
}
