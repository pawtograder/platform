"use client";

import { ViewAsStudentPicker } from "@/components/course/view-as-student-picker";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Button, HStack, Text } from "@chakra-ui/react";
import { FaEye } from "react-icons/fa";

/**
 * Sticky banner shown while an instructor is viewing the course as a student (read-only).
 * Provides an unmissable indicator and a one-click exit.
 *
 * While previewing their own test-assignment work, the banner also offers a switch to a real
 * enrolled student: that preview only covers the assignment it was entered from, so the banner is
 * where an instructor who wants a course-wide student view will be standing (issue #892).
 */
export function ViewAsBanner() {
  const { isViewingAsStudent, isViewingAsSelf, viewAsProfileName, exitViewAs } = useClassProfiles();

  if (!isViewingAsStudent) {
    return null;
  }

  return (
    <HStack
      role="alert"
      aria-label="Viewing as student"
      position="sticky"
      top="0"
      zIndex="banner"
      justifyContent="center"
      gap={3}
      px={4}
      py={2}
      colorPalette="orange"
      bg="colorPalette.solid"
      color="colorPalette.contrast"
      fontWeight="medium"
      wrap="wrap"
    >
      <FaEye aria-hidden />
      {isViewingAsSelf ? (
        <Text fontSize="sm">
          Previewing your own submission as a student — read only, and only for this assignment. Navigate away to return
          to your staff view.
        </Text>
      ) : (
        <Text fontSize="sm">
          Viewing as {viewAsProfileName ?? "student"} — read only. You cannot make changes in this mode.
        </Text>
      )}
      {isViewingAsSelf && <ViewAsStudentPicker />}
      <Button size="xs" variant="surface" colorPalette="orange" onClick={exitViewAs} aria-label="Exit student view">
        Exit student view
      </Button>
    </HStack>
  );
}
