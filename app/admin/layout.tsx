import { createClient } from "@/utils/supabase/server";
import { Link, Box, Flex, VStack, HStack, Heading, Text } from "@chakra-ui/react";
import { TimeZoneProvider } from "@/lib/TimeZoneProvider";
import { redirect } from "next/navigation";
import { ReactNode } from "react";

/** Default when no course context; matches course layout fallback. */
const ADMIN_DISPLAY_TIME_ZONE = "America/New_York";

export const metadata = {
  title: {
    default: "Admin · Pawtograder",
    template: "%s · Admin · Pawtograder"
  }
};

interface AdminLayoutProps {
  children: ReactNode;
}

/**
 * Admin layout that ensures only users with admin role can access admin pages
 */
export default async function AdminLayout({ children }: AdminLayoutProps) {
  const supabase = await createClient();

  // Get current user
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect("/sign-in");
  }

  // Check if user has admin role
  const { data: adminRoles, error: roleError } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .limit(1);

  if (roleError || !adminRoles || adminRoles.length === 0) {
    redirect("/course"); // Redirect non-admin users
  }

  return (
    <TimeZoneProvider courseTimeZone={ADMIN_DISPLAY_TIME_ZONE}>
      <Box minH="100vh" bg="bg.canvas">
        <Box as="header" bg="bg" shadow="sm" borderBottom="1px" borderColor="border.muted">
          <Box maxW="7xl" mx="auto" px={{ base: 4, sm: 6, lg: 8 }}>
            <Flex justify="space-between" align="center" py={4}>
              <VStack align="start" gap={1}>
                <Heading size="xl" color="gray.900">
                  Admin Portal
                </Heading>
                <Text fontSize="sm" color="gray.600">
                  Manage courses and system settings
                </Text>
              </VStack>
              <HStack as="nav" id="primary-nav" aria-label="Admin navigation" gap={4}>
                <Link
                  href="/admin"
                  color="blue.fg"
                  _hover={{ color: "blue.solid" }}
                  px={3}
                  py={2}
                  rounded="md"
                  fontSize="sm"
                  fontWeight="medium"
                >
                  Overview
                </Link>
                <Link
                  href="/admin/classes"
                  color="blue.600"
                  _hover={{ color: "blue.800" }}
                  px={3}
                  py={2}
                  rounded="md"
                  fontSize="sm"
                  fontWeight="medium"
                >
                  Classes
                </Link>
                <Link
                  href="/admin/import"
                  color="blue.600"
                  _hover={{ color: "blue.800" }}
                  px={3}
                  py={2}
                  rounded="md"
                  fontSize="sm"
                  fontWeight="medium"
                >
                  Import
                </Link>
                <Link
                  href="/admin/sis-sync"
                  color="blue.600"
                  _hover={{ color: "blue.800" }}
                  px={3}
                  py={2}
                  rounded="md"
                  fontSize="sm"
                  fontWeight="medium"
                >
                  SIS Sync
                </Link>
                <Link
                  href="/admin/notifications"
                  color="blue.600"
                  _hover={{ color: "blue.800" }}
                  px={3}
                  py={2}
                  rounded="md"
                  fontSize="sm"
                  fontWeight="medium"
                >
                  Notifications
                </Link>
                <Link
                  href="/admin/signup-welcome"
                  color="blue.600"
                  _hover={{ color: "blue.800" }}
                  px={3}
                  py={2}
                  rounded="md"
                  fontSize="sm"
                  fontWeight="medium"
                >
                  Welcome Message
                </Link>
                <Link
                  href="/course"
                  color="fg.muted"
                  _hover={{ color: "fg" }}
                  px={3}
                  py={2}
                  rounded="md"
                  fontSize="sm"
                  fontWeight="medium"
                >
                  Back to Courses
                </Link>
              </HStack>
            </Flex>
          </Box>
        </Box>
        <Box
          as="main"
          id="main-content"
          tabIndex={-1}
          outline="none"
          maxW="7xl"
          mx="auto"
          py={6}
          px={{ base: 4, sm: 6, lg: 8 }}
        >
          {children}
        </Box>
      </Box>
    </TimeZoneProvider>
  );
}
