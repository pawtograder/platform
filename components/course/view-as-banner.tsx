"use client";

import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Button, HStack, Text } from "@chakra-ui/react";
import { FaEye } from "react-icons/fa";

/**
 * Sticky banner shown while staff are viewing the course as a student (read-only).
 * Provides an unmissable indicator and a one-click exit.
 *
 * The self case (previewing your own test-assignment submission) says so explicitly, and says that
 * it covers only this assignment: it is the staff member's own profile wearing a student's view, so
 * enrollment-keyed pages have nothing to show for it and it is scoped accordingly. Reading
 * "Viewing as <your own name>" there made the whole feature look half-built (issue #892).
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
      <Button size="xs" variant="surface" colorPalette="orange" onClick={exitViewAs} aria-label="Exit student view">
        Exit student view
      </Button>
    </HStack>
  );
}
