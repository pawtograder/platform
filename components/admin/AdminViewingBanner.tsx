"use client";

import { useClassProfiles, useIsAdmin } from "@/hooks/useClassProfiles";
import { clearActingAsAdminCookie, getActingAsAdminCookie } from "@/lib/adminActingAs";
import { Box, HStack, Link, Text } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FaUserShield } from "react-icons/fa";

/**
 * Shown across the course manage area when a global admin entered the course via "Manage as
 * instructor" (acting-as), so it's obvious they're impersonating rather than acting as a regular
 * member. It deliberately does NOT show for an admin who is a genuine instructor of the course
 * (no acting-as flag) — that admin is using their real enrollment.
 */
export default function AdminViewingBanner() {
  const isAdmin = useIsAdmin();
  const { role } = useClassProfiles();
  const { course_id } = useParams();
  // The acting-as flag is a client-only cookie; read it after mount to avoid an SSR/hydration
  // mismatch (document is undefined during server render).
  const [actingAs, setActingAs] = useState(false);
  useEffect(() => {
    if (typeof course_id === "string") setActingAs(getActingAsAdminCookie(course_id));
  }, [course_id]);

  if (!isAdmin || !actingAs) {
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
        <Link
          href="/admin"
          fontSize="sm"
          fontWeight="medium"
          color="orange.fg"
          // Clear the acting-as flag on exit so the banner doesn't keep showing on this course for
          // the rest of the session (the cookie is otherwise never cleared, which misleadingly
          // marks even a later genuine-instructor visit as impersonation).
          onClick={() => {
            if (typeof course_id === "string") clearActingAsAdminCookie(course_id);
          }}
        >
          Back to Admin Portal
        </Link>
      </HStack>
    </Box>
  );
}
