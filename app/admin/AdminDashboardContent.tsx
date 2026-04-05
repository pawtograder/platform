import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Button } from "@/components/ui/button";
import { getCachedAdminDashboardStats } from "@/lib/server-route-cache";
import * as Sentry from "@sentry/nextjs";
import { Card, Flex, Grid, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { FileText, GraduationCap, MessageSquare, Plus, Settings, Users } from "lucide-react";
import Link from "next/link";

export async function AdminDashboardContent() {
  const { totalClasses, totalUsers, totalEnrollments, recentClasses, errors } = await getCachedAdminDashboardStats();
  if (errors.length > 0) {
    Sentry.captureMessage(`Admin dashboard stats partial failure: ${errors.join("; ")}`);
  }

  return (
    <>
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
                      <TimeZoneAwareDate date={course.created_at} format="dateOnly" />
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
    </>
  );
}
