"use client";

import { useClassSections, useCourseController, useLabSections } from "@/hooks/useCourseController";
import type { UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import { useFindTableControllerValue } from "@/lib/TableController";
import { HStack, Icon } from "@chakra-ui/react";
import { ReactNode, useCallback, useMemo } from "react";
import { BsPerson } from "react-icons/bs";
import { Tooltip } from "./tooltip";
import Link from "./link";

export default function StudentSummaryTrigger({
  student_id,
  course_id,
  children
}: {
  student_id: string;
  course_id: number;
  children?: ReactNode;
}) {
  const controller = useCourseController();
  const classSections = useClassSections();
  const labSections = useLabSections();

  const matcher = useCallback(
    (r: UserRoleWithPrivateProfileAndUser) => r.private_profile_id === student_id,
    [student_id]
  );
  const userRole = useFindTableControllerValue(controller.userRolesWithProfiles, matcher);

  const tooltipContent = useMemo(() => {
    const parts: string[] = [];
    if (userRole?.class_section_id && classSections) {
      const classSection = classSections.find((s) => s.id === userRole.class_section_id);
      if (classSection) {
        parts.push(`Class: ${classSection.name || `Section ${classSection.id}`}`);
      }
    }
    if (userRole?.lab_section_id && labSections) {
      const labSection = labSections.find((s) => s.id === userRole.lab_section_id);
      if (labSection) {
        parts.push(`Lab: ${labSection.name || `Lab ${labSection.id}`}`);
      }
    }
    if (parts.length === 0) return "Open student summary in new tab";
    return `${parts.join(" · ")} · Open student summary in new tab`;
  }, [userRole?.class_section_id, userRole?.lab_section_id, classSections, labSections]);

  return (
    <Tooltip content={tooltipContent}>
      <Link
        href={`/course/${course_id}/manage/student/${encodeURIComponent(student_id)}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open student ${student_id} in new tab`}
        variant="plain"
        _hover={{ bg: "bg.muted", textDecoration: "none" }}
        transition="background-color 0.12s"
        borderRadius="md"
        bg="bg.subtle"
        px={1.5}
        py={0.5}
        display="inline-flex"
      >
        <HStack gap={1.5} align="center">
          {children}
          <Icon as={BsPerson} color="fg.muted" />
        </HStack>
      </Link>
    </Tooltip>
  );
}
