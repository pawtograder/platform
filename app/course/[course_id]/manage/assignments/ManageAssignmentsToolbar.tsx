"use client";

import { Button, HStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useCapability } from "@/hooks/useClassProfiles";
import SyncStaffTeamButton from "@/app/course/[course_id]/manage/assignments/syncStaffTeamButton";

export function ManageAssignmentsToolbar({ courseId }: { courseId: number }) {
  // Creating an assignment needs manage_assignments (#1010).
  const canManageAssignments = useCapability("manage_assignments");
  return (
    <HStack p={2} flexWrap="wrap" gap={2}>
      {canManageAssignments && (
        <Button size="xs" asChild variant="solid" colorPalette="green">
          <NextLink href={`/course/${courseId}/manage/assignments/new`}>New Assignment</NextLink>
        </Button>
      )}
      <Button size="xs" asChild variant="outline">
        <NextLink href={`/course/${courseId}/manage/regrade-requests`}>All regrade requests</NextLink>
      </Button>
      <SyncStaffTeamButton course_id={courseId} />
    </HStack>
  );
}
