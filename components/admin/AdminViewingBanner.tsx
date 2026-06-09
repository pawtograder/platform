"use client";

import { useClassProfiles, useIsAdmin } from "@/hooks/useClassProfiles";
import { Box, HStack, Link, Text } from "@chakra-ui/react";
import { FaUserShield } from "react-icons/fa";

/**
 * Shown across the course manage area when the current user holds a global admin role.
 * Makes it obvious the admin is acting inside a course (often via "Manage as instructor")
 * rather than as a regular member, and offers a quick way back to the admin portal.
 */
export default function AdminViewingBanner() {
  const isAdmin = useIsAdmin();
  const { role } = useClassProfiles();

  if (!isAdmin) {
    return null;
  }

  const courseName = (role.classes as { name?: string | null })?.name ?? "this course";

  return (
    <Box
      bg="orange.subtle"
      color="orange.fg"
      borderBottomWidth="1px"
      borderColor="orange.muted"
      px={4}
      py={2}
      data-testid="admin-viewing-banner"
    >
      <HStack justify="space-between" wrap="wrap" gap={2} maxW="7xl" mx="auto">
        <HStack gap={2}>
          <FaUserShield aria-hidden />
          <Text fontSize="sm">
            You are viewing{" "}
            <Text as="span" fontWeight="semibold">
              {courseName}
            </Text>{" "}
            as a platform admin.
          </Text>
        </HStack>
        <Link href="/admin" fontSize="sm" fontWeight="medium" color="orange.fg">
          Back to Admin Portal
        </Link>
      </HStack>
    </Box>
  );
}
