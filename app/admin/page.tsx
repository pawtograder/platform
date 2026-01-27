import { createClient } from "@/utils/supabase/server";
import { Button } from "@/components/ui/button";
import { Plus, Users, GraduationCap, Settings, FileText, MessageSquare, Mail } from "lucide-react";
import { Card, Text, Flex, Grid, HStack, VStack, Heading, Icon } from "@chakra-ui/react";
import Link from "next/link";

/**
 * Admin dashboard overview page
 */
export default async function AdminPage() {
  const supabase = await createClient();

  // Get system statistics
  const [{ count: totalClasses }, { count: totalUsers }, { count: totalEnrollments }, { data: recentClasses }] =
    await Promise.all([
      supabase.from("classes").select("*", { count: "exact", head: true }),
      supabase.from("users").select("*", { count: "exact", head: true }),
      supabase.from("user_roles").select("*", { count: "exact", head: true }),
      supabase.from("classes").select("id, name, created_at").order("created_at", { ascending: false }).limit(5)
    ]);

  return (
    <VStack align="stretch" gap={6}>
      {/* Header */}
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">Dashboard</Heading>
          <Text color="fg.muted">Overview of your platform</Text>
        </VStack>
        <Button asChild>
          <Link href="/admin/classes">
            <HStack gap={2}>
              <Plus size={16} />
              <Text>New Class</Text>
            </HStack>
          </Link>
        </Button>
      </Flex>

      {/* Stats Cards */}
      <Grid templateColumns="repeat(auto-fit, minmax(250px, 1fr))" gap={4}>
        <Card.Root>
          <Card.Header>
            <Flex justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="medium">
                Total Classes
              </Text>
              <Icon color="gray.500">
                <GraduationCap size={16} />
              </Icon>
            </Flex>
          </Card.Header>
          <Card.Body>
            <Text fontSize="2xl" fontWeight="bold">
              {totalClasses || 0}
            </Text>
            <Text fontSize="xs" color="fg.subtle">
              Active courses
            </Text>
          </Card.Body>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Flex justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="medium">
                Total Users
              </Text>
              <Icon color="gray.500">
                <Users size={16} />
              </Icon>
            </Flex>
          </Card.Header>
          <Card.Body>
            <Text fontSize="2xl" fontWeight="bold">
              {totalUsers || 0}
            </Text>
            <Text fontSize="xs" color="gray.500">
              Registered users
            </Text>
          </Card.Body>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Flex justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="medium">
                Total Enrollments
              </Text>
              <Icon color="gray.500">
                <FileText size={16} />
              </Icon>
            </Flex>
          </Card.Header>
          <Card.Body>
            <Text fontSize="2xl" fontWeight="bold">
              {totalEnrollments || 0}
            </Text>
            <Text fontSize="xs" color="gray.500">
              User enrollments
            </Text>
          </Card.Body>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Flex justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="medium">
                System Status
              </Text>
              <Icon color="gray.500">
                <Settings size={16} />
              </Icon>
            </Flex>
          </Card.Header>
          <Card.Body>
            <Text fontSize="2xl" fontWeight="bold" color="green.600">
              Healthy
            </Text>
            <Text fontSize="xs" color="gray.500">
              All systems operational
            </Text>
          </Card.Body>
        </Card.Root>
      </Grid>

      {/* Recent Classes and Quick Actions */}
      <Grid templateColumns="2fr 1fr" gap={4}>
        <Card.Root>
          <Card.Header>
            <Card.Title>Recent Classes</Card.Title>
            <Text color="fg.muted">Latest created classes</Text>
          </Card.Header>
          <Card.Body>
            <VStack gap={8}>
              {recentClasses?.map((course) => (
                <Flex key={course.id} align="center" w="full">
                  <VStack align="start" flex={1} gap={1}>
                    <Text fontSize="sm" fontWeight="medium">
                      {course.name}
                    </Text>
                    <Text fontSize="sm" color="fg.subtle">
                      {formatDate(course.created_at)}
                    </Text>
                  </VStack>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/admin/classes">Manage</Link>
                  </Button>
                </Flex>
              )) || (
                <Text fontSize="sm" color="fg.subtle">
                  No classes yet
                </Text>
              )}
            </VStack>
          </Card.Body>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Quick Actions</Card.Title>
            <Text color="fg.muted">Common administrative tasks</Text>
          </Card.Header>
          <Card.Body>
            <VStack gap={4}>
              <Button variant="outline" w="full" justifyContent="start" asChild>
                <Link href="/admin/classes">
                  <HStack gap={2}>
                    <Plus size={16} />
                    <Text>Create New Class</Text>
                  </HStack>
                </Link>
              </Button>
              <Button variant="outline" w="full" justifyContent="start" asChild>
                <Link href="/admin/import">
                  <HStack gap={2}>
                    <Plus size={16} />
                    <Text>Import from SIS</Text>
                  </HStack>
                </Link>
              </Button>
              <Button variant="outline" w="full" justifyContent="start" asChild>
                <Link href="/admin/sis-sync">
                  <HStack gap={2}>
                    <Settings size={16} />
                    <Text>Monitor SIS Sync</Text>
                  </HStack>
                </Link>
              </Button>
              <Button variant="outline" w="full" justifyContent="start" asChild>
                <Link href="/admin/classes">
                  <HStack gap={2}>
                    <Settings size={16} />
                    <Text>Manage Classes</Text>
                  </HStack>
                </Link>
              </Button>
              <Button variant="outline" w="full" justifyContent="start" asChild>
                <Link href="/admin/notifications">
                  <HStack gap={2}>
                    <Plus size={16} />
                    <Text>Create Notification</Text>
                  </HStack>
                </Link>
              </Button>
              <Button variant="outline" w="full" justifyContent="start" asChild>
                <Link href="/admin/signup-welcome">
                  <HStack gap={2}>
                    <MessageSquare size={16} />
                    <Text>Configure Welcome Message</Text>
                  </HStack>
                </Link>
              </Button>
              <Button variant="outline" w="full" justifyContent="start" asChild>
                <Link href="/admin/email-templates">
                  <HStack gap={2}>
                    <Mail size={16} />
                    <Text>Manage Email Templates</Text>
                  </HStack>
                </Link>
              </Button>
              <Button variant="outline" w="full" justifyContent="start" asChild>
                <Link href="/course">
                  <HStack gap={2}>
                    <FileText size={16} />
                    <Text>View as User</Text>
                  </HStack>
                </Link>
              </Button>
            </VStack>
          </Card.Body>
        </Card.Root>
      </Grid>
    </VStack>
  );
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}
