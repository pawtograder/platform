"use client";

import { useParams } from "next/navigation";
import { redirect } from "next/navigation";
import { Box, Card, Container, Heading, Stack, Text, Grid, Badge, Button, HStack, VStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { BsChatText, BsCameraVideo, BsGeoAlt, BsPeople, BsPersonBadge } from "react-icons/bs";
import PersonAvatar from "@/components/ui/person-avatar";
import { useMemo, useCallback } from "react";
import ModerationBanNotice from "@/components/ui/moderation-ban-notice";
import { ClassProfileProvider } from "@/hooks/useClassProfiles";
import {
  useHelpQueues,
  useHelpQueueAssignments,
  useHelpRequests,
  useHelpRequestStudents,
  useConnectionStatus
} from "@/hooks/useOfficeHoursRealtime";
import type { HelpRequest, HelpQueueAssignment } from "@/utils/supabase/DatabaseTypes";

export default function OfficeHoursPage() {
  const { course_id } = useParams();
  const classId = Number(course_id);

  // Use individual hooks for office hours data
  const allHelpQueues = useHelpQueues();
  const allHelpQueueAssignments = useHelpQueueAssignments();
  const allHelpRequests = useHelpRequests();
  const helpRequestStudents = useHelpRequestStudents();
  const { connectionStatus, connectionError, isLoading } = useConnectionStatus();

  // Filter data based on requirements
  const helpQueues = allHelpQueues.filter((queue) => queue.available);
  const helpQueueAssignments = allHelpQueueAssignments.filter((assignment) => assignment.is_active);
  const activeHelpRequests = allHelpRequests.filter(
    (request) => request.status === "open" || request.status === "in_progress"
  );

  // Memoize computation-heavy operations with proper dependencies
  const activeRequestsByQueue = useMemo(() => {
    if (!activeHelpRequests?.length || !helpRequestStudents?.length) return {};

    // Create mapping of request ID to student profile IDs
    const studentsByRequestId = helpRequestStudents.reduce(
      (acc, student) => {
        if (!acc[student.help_request_id]) {
          acc[student.help_request_id] = [];
        }
        acc[student.help_request_id].push(student.profile_id);
        return acc;
      },
      {} as Record<number, string[]>
    );

    // Group requests by queue ID, ensuring consistent number types
    return activeHelpRequests.reduce(
      (acc, request) => {
        const queueId = Number(request.help_queue);
        if (!acc[queueId]) {
          acc[queueId] = [];
        }
        acc[queueId].push({
          ...request,
          students: studentsByRequestId[request.id] || []
        });
        return acc;
      },
      {} as Record<number, (HelpRequest & { students: string[] })[]>
    );
  }, [activeHelpRequests, helpRequestStudents]);

  // Group active assignments by queue with proper dependencies
  const activeAssignmentsByQueue = useMemo(() => {
    if (!helpQueueAssignments?.length) return {};

    return helpQueueAssignments.reduce(
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
  }, [helpQueueAssignments]);

  // Memoize helper functions to prevent unnecessary re-renders
  const getQueueIcon = useCallback((type: string) => {
    switch (type) {
      case "video":
        return <BsCameraVideo />;
      case "in_person":
        return <BsGeoAlt />;
      default:
        return <BsChatText />;
    }
  }, []);

  const getQueueDescription = useCallback((type: string) => {
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
  }, []);

  if (isLoading) {
    return (
      <Container>
        <Box textAlign="center" py={8}>
          <Text>Loading help queues...</Text>
        </Box>
      </Container>
    );
  }

  if (connectionError || connectionStatus?.overall === "disconnected") {
    return (
      <Container>
        <Box textAlign="center" py={8}>
          <Card.Root variant="outline" borderColor="red.200">
            <Card.Body>
              <Text color="red.500">{connectionError || "Connection error. Please try refreshing the page."}</Text>
              <Button mt={4} onClick={() => window.location.reload()}>
                Refresh Page
              </Button>
            </Card.Body>
          </Card.Root>
        </Box>
      </Container>
    );
  }

  const availableQueues = helpQueues ?? [];

  if (availableQueues.length === 1) {
    redirect(`/course/${course_id}/office-hours/${availableQueues[0].id}`);
  }

  return (
    <ClassProfileProvider>
      <ModerationBanNotice classId={classId}>
        <Container maxW={{ base: "md", md: "6xl" }} px={{ base: 3, md: 0 }} my={{ base: 2, md: 4 }}>
          <Stack spaceY={{ base: 4, md: 6 }}>
            <Box textAlign="center">
              <Heading size={{ base: "md", md: "lg" }} mb={{ base: 1, md: 2 }}>
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
              <Box maxW={{ base: "md", md: "full" }} w={{ base: "auto", md: "full" }} mx="auto">
                <Grid columns={{ base: 1, md: 2 }} gap={{ base: 3, md: 4 }}>
                  {availableQueues.map((queue) => {
                    const queueRequests = activeRequestsByQueue[Number(queue.id)] || [];
                    // Flatten all student IDs from all requests in this queue
                    const activeUsers = queueRequests.flatMap((request) => request.students);
                    const queueAssignments = activeAssignmentsByQueue[queue.id] || [];
                    const activeStaff = queueAssignments.map((assignment) => assignment.ta_profile_id);

                    return (
                      <Card.Root
                        key={`queue-${queue.id}-${queue.name}`}
                        variant="outline"
                        w="full"
                        role="region"
                        aria-label={`Help queue: ${queue.name}`}
                        _hover={{ borderColor: "border.emphasized" }}
                      >
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
                                    <PersonAvatar
                                      key={`staff-${staffId}-${index}-${queue.id}`}
                                      uid={staffId}
                                      size="sm"
                                    />
                                  ))}
                                  {activeStaff.length > 4 && <Text fontSize="xs">+{activeStaff.length - 4} more</Text>}
                                </HStack>
                              ) : (
                                <Text fontSize="xs" color="gray.500">
                                  No staff currently on duty
                                </Text>
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
                                    <PersonAvatar key={`user-${userId}-${index}-${queue.id}`} uid={userId} size="xs" />
                                  ))}
                                  {activeUsers.length > 6 && <Text fontSize="xs">+{activeUsers.length - 6} more</Text>}
                                </HStack>
                              ) : (
                                <Text fontSize="xs" color="gray.500">
                                  No one currently in queue
                                </Text>
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
              </Box>
            )}
          </Stack>
        </Container>
      </ModerationBanNotice>
    </ClassProfileProvider>
  );
}
