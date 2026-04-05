"use client";

import { Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";
import SyncStaffTeamButton from "./syncStaffTeamButton";

export function ManageAssignmentsToolbar({ courseId }: { courseId: number }) {
  return (
    <HStack p={2}>
      <Button size="xs" asChild variant="solid" colorPalette="green">
        <NextLink href={`/course/${courseId}/manage/assignments/new`}>New Assignment</NextLink>
      </Button>
      <SyncStaffTeamButton course_id={courseId} />
    </HStack>
  );
}
