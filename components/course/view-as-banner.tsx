"use client";

import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Button, HStack, Text } from "@chakra-ui/react";
import { FaEye } from "react-icons/fa";

/**
 * Sticky banner shown while an instructor is viewing the course as a student (read-only).
 * Provides an unmissable indicator and a one-click exit.
 */
export function ViewAsBanner() {
  const { isViewingAsStudent, viewAsProfileName, exitViewAs } = useClassProfiles();

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
    >
      <FaEye aria-hidden />
      <Text fontSize="sm">
        Viewing as {viewAsProfileName ?? "student"} — read only. You cannot make changes in this mode.
      </Text>
      <Button size="xs" variant="surface" colorPalette="orange" onClick={exitViewAs} aria-label="Exit student view">
        Exit student view
      </Button>
    </HStack>
  );
}
