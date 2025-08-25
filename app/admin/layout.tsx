import { createClient } from "@/utils/supabase/server";
import { Box, Flex, HStack, Text, Container, Button } from "@chakra-ui/react";
import { redirect } from "next/navigation";
import { ReactNode } from "react";
import Link from "next/link";

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
    <Box minH="100vh" bg="bg.canvas">
      <Box
        as="nav"
        position="fixed"
        top={0}
        left={0}
        right={0}
        zIndex={1000}
        bg="white"
        borderBottom="1px"
        borderColor="gray.200"
        _dark={{
          bg: "gray.900",
          borderColor: "gray.700"
        }}
      >
        <Container maxW="7xl" py={4}>
          <Flex align="center" justify="space-between">
            <Link href="/admin" passHref>
              <Text
                fontSize="2xl"
                fontWeight="bold"
                color="blue.600"
                _dark={{ color: "blue.400" }}
                _hover={{ color: "blue.700", _dark: { color: "blue.300" } }}
                transition="color 0.2s"
              >
                Pawtograder Admin
              </Text>
            </Link>

            <HStack gap={4}>
              <Link href="/admin/classes" passHref>
                <Button
                  variant="ghost"
                  colorScheme="blue"
                  size="sm"
                  rounded="md"
                  data-visual-test-no-radius
                  _hover={{
                    bg: "blue.50",
                    _dark: { bg: "blue.900" }
                  }}
                >
                  Classes
                </Button>
              </Link>

              <Link href="/admin/import" passHref>
                <Button
                  variant="ghost"
                  colorScheme="blue"
                  size="sm"
                  rounded="md"
                  data-visual-test-no-radius
                  _hover={{
                    bg: "blue.50",
                    _dark: { bg: "blue.900" }
                  }}
                >
                  Import
                </Button>
              </Link>

              <Link href="/admin/notifications" passHref>
                <Button
                  variant="ghost"
                  colorScheme="blue"
                  size="sm"
                  rounded="md"
                  data-visual-test-no-radius
                  _hover={{
                    bg: "blue.50",
                    _dark: { bg: "blue.900" }
                  }}
                >
                  Notifications
                </Button>
              </Link>

              <Link href="/admin/sis-sync" passHref>
                <Button
                  variant="ghost"
                  colorScheme="blue"
                  size="sm"
                  rounded="md"
                  data-visual-test-no-radius
                  _hover={{
                    bg: "blue.50",
                    _dark: { bg: "blue.900" }
                  }}
                >
                  SIS Sync
                </Button>
              </Link>

              <Link href="/admin/signup-welcome" passHref>
                <Button
                  variant="ghost"
                  colorScheme="blue"
                  size="sm"
                  rounded="md"
                  data-visual-test-no-radius
                  _hover={{
                    bg: "blue.50",
                    _dark: { bg: "blue.900" }
                  }}
                >
                  Signup Welcome
                </Button>
              </Link>

              <Link href="/admin/metrics" passHref>
                <Button
                  variant="ghost"
                  colorScheme="blue"
                  size="sm"
                  rounded="md"
                  data-visual-test-no-radius
                  _hover={{
                    bg: "blue.50",
                    _dark: { bg: "blue.900" }
                  }}
                >
                  Metrics
                </Button>
              </Link>
            </HStack>
          </Flex>
        </Container>
      </Box>
      <Box as="main" maxW="7xl" mx="auto" py={6} px={{ base: 4, sm: 6, lg: 8 }}>
        {children}
      </Box>
    </Box>
  );
}
