"use client";

import { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { redirect } from "next/navigation";
import { Box, Card, Container, Heading, Stack, Text, Grid, Badge, Button, HStack, VStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { BsChatText, BsCameraVideo, BsGeoAlt, BsPeople, BsPersonBadge } from "react-icons/bs";
import PersonAvatar from "@/components/ui/person-avatar";
import { useMemo } from "react";
import ModerationBanNotice from "@/components/ui/moderation-ban-notice";
import { ClassProfileProvider } from "@/hooks/useClassProfiles";

// Type for help queue assignments based on database schema
type HelpQueueAssignment = {
  id: number;
  help_queue_id: number;
  ta_profile_id: string;
  is_active: boolean;
  started_at: string;
  ended_at: string | null;
  class_id: number;
  max_concurrent_students: number;
};

export default function OfficeHoursPage() {
  const { course_id } = useParams();

  const queues = useList<HelpQueue>({
    resource: "help_queues",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "available", operator: "eq", value: true }
    ]
  });

  // Fetch active help requests for all queues
  const activeRequests = useList<HelpRequest>({
    resource: "help_requests",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "status", operator: "in", value: ["open", "in_progress"] }
    ],
    sorters: [{ field: "created_at", order: "asc" }],
    pagination: { pageSize: 1000 } // Get all active requests
  });

  // Fetch active queue assignments (staff currently working)
  const activeAssignments = useList<HelpQueueAssignment>({
    resource: "help_queue_assignments",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "is_active", operator: "eq", value: true }
    ],
    sorters: [{ field: "started_at", order: "asc" }],
    pagination: { pageSize: 1000 }
  });

  // Group active requests by queue
  const activeRequestsByQueue = useMemo(() => {
    if (!activeRequests.data?.data) return {};

    return activeRequests.data.data.reduce(
      (acc, request) => {
        const queueId = request.help_queue;
        if (!acc[queueId]) {
          acc[queueId] = [];
        }
        acc[queueId].push(request);
        return acc;
      },
      {} as Record<number, HelpRequest[]>
    );
  }, [activeRequests.data?.data]);

  // Group active assignments by queue
  const activeAssignmentsByQueue = useMemo(() => {
    if (!activeAssignments.data?.data) return {};

    return activeAssignments.data.data.reduce(
      (acc, assignment) => {
        const queueId = assignment.help_queue_id;
        if (!acc[queueId]) {
          acc[queueId] = [];
        }
        acc[queueId].push(assignment);
        return acc;
      },
      {} as Record<number, HelpQueueAssignment[]>
    );
  }, [activeAssignments.data?.data]);

  if (queues.isLoading || activeRequests.isLoading || activeAssignments.isLoading) {
    return (
      <Container>
        <Text>Loading help queues...</Text>
      </Container>
    );
  }
  if (queues.error) {
    return (
      <Container>
        <Text color="red.500">Error: {queues.error.message}</Text>
      </Container>
    );
  }

  const availableQueues = queues.data?.data ?? [];

  if (availableQueues.length === 1) {
    redirect(`/course/${course_id}/office-hours/${availableQueues[0].id}`);
  }

  const getQueueIcon = (type: string) => {
    switch (type) {
      case "video":
        return <BsCameraVideo />;
      case "in_person":
        return <BsGeoAlt />;
      default:
        return <BsChatText />;
    }
  };

  const getQueueDescription = (type: string) => {
    switch (type) {
      case "video":
        return "Live video chat with TAs";
      case "in_person":
        return "Get help in person";
      case "text":
        return "Text-based help and discussion";
      default:
        return "Get help from TAs and instructors";
    }
  };

  return (
    <ClassProfileProvider>
      <ModerationBanNotice classId={Number(course_id)}>
        <Container maxW="4xl" py={8}>
          <Stack spaceY={6}>
            <Box textAlign="center">
              <Heading size="lg" mb={2}>
                Ask for Help
              </Heading>
              <Text>Choose a help queue to get assistance from course staff</Text>
            </Box>

            {availableQueues.length === 0 ? (
              <Card.Root>
                <Card.Body>
                  <Text textAlign="center">No help queues are currently available.</Text>
                </Card.Body>
              </Card.Root>
            ) : (
              <Grid columns={{ base: 1, md: 2 }} gap={4}>
                {availableQueues.map((queue) => {
                  const queueRequests = activeRequestsByQueue[queue.id] || [];
                  const activeUsers = queueRequests.map((request) => request.creator);
                  const queueAssignments = activeAssignmentsByQueue[queue.id] || [];
                  const activeStaff = queueAssignments.map((assignment) => assignment.ta_profile_id);

                  return (
                    <Card.Root key={queue.id} variant="outline" _hover={{ borderColor: "border.emphasized" }}>
                      <Card.Body>
                        <Stack spaceY={4}>
                          <Stack direction="row" align="center" justify="space-between">
                            <Stack direction="row" align="center" spaceX={2}>
                              <Box color={queue.color || "fg.default"}>{getQueueIcon(queue.queue_type)}</Box>
                              <Heading size="sm">{queue.name}</Heading>
                            </Stack>
                            <Badge
                              colorPalette={
                                queue.queue_type === "video"
                                  ? "green"
                                  : queue.queue_type === "in_person"
                                    ? "orange"
                                    : "blue"
                              }
                            >
                              {queue.queue_type}
                            </Badge>
                          </Stack>

                          <Text fontSize="sm">{queue.description || getQueueDescription(queue.queue_type)}</Text>

                          {/* Active staff in queue */}
                          <VStack align="stretch" spaceY={2}>
                            <HStack align="center" spaceX={2}>
                              <BsPersonBadge />
                              <Text fontSize="sm" fontWeight="medium">
                                Staff on duty ({activeStaff.length})
                              </Text>
                            </HStack>

                            {activeStaff.length > 0 ? (
                              <HStack wrap="wrap" gap={2}>
                                {activeStaff.slice(0, 4).map((staffId, index) => (
                                  <PersonAvatar key={`staff-${staffId}-${index}`} uid={staffId} size="sm" />
                                ))}
                                {activeStaff.length > 4 && <Text fontSize="xs">+{activeStaff.length - 4} more</Text>}
                              </HStack>
                            ) : (
                              <Text fontSize="xs">No staff currently on duty</Text>
                            )}
                          </VStack>

                          {/* Active students in queue */}
                          <VStack align="stretch" spaceY={2}>
                            <HStack align="center" spaceX={2}>
                              <BsPeople />
                              <Text fontSize="sm" fontWeight="medium">
                                Currently in queue ({queueRequests.length})
                              </Text>
                            </HStack>

                            {activeUsers.length > 0 ? (
                              <HStack wrap="wrap" gap={2}>
                                {activeUsers.slice(0, 6).map((userId, index) => (
                                  <PersonAvatar key={`${userId}-${index}`} uid={userId} size="xs" />
                                ))}
                                {activeUsers.length > 6 && <Text fontSize="xs">+{activeUsers.length - 6} more</Text>}
                              </HStack>
                            ) : (
                              <Text fontSize="xs">No one currently in queue</Text>
                            )}
                          </VStack>

                          <NextLink href={`/course/${course_id}/office-hours/${queue.id}`} passHref>
                            <Button variant="outline" size="sm" width="full">
                              Join Queue
                            </Button>
                          </NextLink>
                        </Stack>
                      </Card.Body>
                    </Card.Root>
                  );
                })}
              </Grid>
            )}
          </Stack>
        </Container>
      </ModerationBanNotice>
    </ClassProfileProvider>
  );
}
