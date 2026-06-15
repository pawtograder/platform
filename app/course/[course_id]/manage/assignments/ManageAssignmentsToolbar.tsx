"use client";

import { Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";
import SyncStaffTeamButton from "@/app/course/[course_id]/manage/assignments/syncStaffTeamButton";

export function ManageAssignmentsToolbar({ courseId }: { courseId: number }) {
  return (
    <HStack p={2} flexWrap="wrap" gap={2}>
      <Button size="xs" asChild variant="solid" colorPalette="green">
        <NextLink href={`/course/${courseId}/manage/assignments/new`}>New Assignment</NextLink>
      </Button>
      <Button size="xs" asChild variant="outline">
        <NextLink href={`/course/${courseId}/manage/regrade-requests`}>All regrade requests</NextLink>
      </Button>
      <SyncStaffTeamButton course_id={courseId} />
    </HStack>
  );
}
