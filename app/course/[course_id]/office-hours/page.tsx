"use client";

import { QueueCard } from "@/components/help-queue/queue-card";
import { RequestRow } from "@/components/help-queue/request-row";
import {
  useConnectionStatus,
  useHelpQueueAssignments,
  useHelpQueues,
  useHelpRequests,
  useHelpRequestStudents
} from "@/hooks/useOfficeHoursRealtime";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Box, Button, Flex, Heading, HStack, Icon, Link, Stack, Text, VStack } from "@chakra-ui/react";
import { redirect, useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import { useOfficeHoursSchedule } from "@/hooks/useCalendarEvents";
import { format, parseISO, isAfter, isSameDay } from "date-fns";
import { BsCalendar, BsClock } from "react-icons/bs";
import QueueWeeklySchedule from "@/components/calendar/queue-weekly-schedule";
import { isEventCurrentlyHappening } from "@/components/calendar/calendar-utils";
import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogCloseTrigger
} from "@/components/ui/dialog";

export default function OfficeHoursPage() {
  const { course_id } = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const view = searchParams.get("view") || "browse";
  const selectedQueueId = searchParams.get("queue") ? Number(searchParams.get("queue")) : null;
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [now, setNow] = useState(new Date());

  // Update current time every minute to check if events are active
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(new Date());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // Use individual hooks for office hours data
  const allHelpQueues = useHelpQueues();
  const allHelpQueueAssignments = useHelpQueueAssignments();
  const allHelpRequests = useHelpRequests();
  const helpRequestStudents = useHelpRequestStudents();
  const officeHoursEvents = useOfficeHoursSchedule();
  const { connectionStatus, connectionError, isLoading } = useConnectionStatus();

  // Get current user profile IDs (needed for My Requests view)
  const { private_profile_id, public_profile_id } = useClassProfiles();

  // Filter data based on requirements
  const helpQueueAssignments = allHelpQueueAssignments.filter((assignment) => assignment.is_active);

  const helpQueues = allHelpQueues
    .filter((queue) => queue.available)
    .sort((a, b) => {
      // Primary sort: by ordinal
      if (a.ordinal !== b.ordinal) {
        return a.ordinal - b.ordinal;
      }
      // Secondary sort: queues with active staff first
      const aHasActive = helpQueueAssignments.some((assignment) => assignment.help_queue_id === a.id);
      const bHasActive = helpQueueAssignments.some((assignment) => assignment.help_queue_id === b.id);
      if (aHasActive !== bHasActive) {
        return aHasActive ? -1 : 1;
      }
      return 0;
    });

  const activeHelpRequests = allHelpRequests.filter(
    (request) => request.status === "open" || request.status === "in_progress"
  );

  // Group active assignments by queue
  const activeAssignmentsByQueue = useMemo(() => {
    return helpQueueAssignments.reduce(
      (acc, assignment) => {
        const queueId = assignment.help_queue_id;
        if (!acc[queueId]) {
          acc[queueId] = [];
        }
        acc[queueId].push(assignment);
        return acc;
      },
      {} as Record<number, typeof helpQueueAssignments>
    );
  }, [helpQueueAssignments]);

  // Create mapping of request ID to student profile IDs
  const requestStudentsMap = useMemo(() => {
    return helpRequestStudents.reduce(
      (acc, student) => {
        if (!acc[student.help_request_id]) {
          acc[student.help_request_id] = [];
        }
        acc[student.help_request_id].push(student.profile_id);
        return acc;
      },
      {} as Record<number, string[]>
    );
  }, [helpRequestStudents]);

  // Get requests for selected queue
  const selectedQueueRequests = useMemo(() => {
    if (!selectedQueueId) return [];
    return activeHelpRequests.filter((r) => r.help_queue === selectedQueueId);
  }, [activeHelpRequests, selectedQueueId]);

  // Get all requests where user is creator or participant (for My Requests view)
  const myRequests = useMemo(() => {
    const userProfileIds = [private_profile_id, public_profile_id];
    const userParticipatedRequestIds = new Set(
      helpRequestStudents
        .filter((student) => userProfileIds.includes(student.profile_id))
        .map((student) => student.help_request_id)
    );

    return allHelpRequests.filter(
      (request) =>
        (request.created_by && userProfileIds.includes(request.created_by)) ||
        userParticipatedRequestIds.has(request.id)
    );
  }, [allHelpRequests, helpRequestStudents, private_profile_id, public_profile_id]);

  // Group and sort requests for My Requests view
  const groupedMyRequests = useMemo(() => {
    const openRequests = myRequests
      .filter((r) => r.status === "open" || r.status === "in_progress")
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const closedRequests = myRequests
      .filter((r) => r.status === "resolved" || r.status === "closed")
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return { openRequests, closedRequests };
  }, [myRequests]);

  const availableQueues = useMemo(() => helpQueues ?? [], [helpQueues]);

  // Get selected queue
  const selectedQueue = useMemo(() => {
    if (!selectedQueueId) return null;
    return availableQueues.find((q) => q.id === selectedQueueId);
  }, [selectedQueueId, availableQueues]);

  // Get upcoming schedule for selected queue
  const upcomingSchedule = useMemo(() => {
    if (!selectedQueueId || !selectedQueue) return [];

    const now = new Date();
    const queueEvents = officeHoursEvents.filter(
      (event) =>
        event.resolved_help_queue_id === selectedQueueId ||
        (event.resolved_help_queue_id === null &&
          event.queue_name &&
          event.queue_name.toLowerCase() === selectedQueue.name.toLowerCase())
    );

    // Get upcoming events (starting from now or later today)
    const upcoming = queueEvents
      .filter((event) => {
        const eventStart = parseISO(event.start_time);
        // Include events starting today or in the future
        return isAfter(eventStart, now) || isSameDay(eventStart, now);
      })
      .sort((a, b) => {
        const aStart = parseISO(a.start_time).getTime();
        const bStart = parseISO(b.start_time).getTime();
        return aStart - bStart;
      })
      .slice(0, 5); // Show next 5 upcoming events

    return upcoming;
  }, [selectedQueueId, selectedQueue, officeHoursEvents]);

  // Auto-select first queue if none selected
  useEffect(() => {
    if (view === "browse" && !selectedQueueId && helpQueues.length > 0) {
      const next = new URLSearchParams(searchParams.toString());
      next.set("view", "browse");
      next.set("queue", helpQueues[0].id.toString());
      router.replace(`/course/${course_id}/office-hours?${next.toString()}`, { scroll: false });
    }
  }, [view, selectedQueueId, helpQueues, searchParams, router, course_id]);

  if (isLoading) {
    return (
      <Box textAlign="center" py={8}>
        <Text>Loading help queues...</Text>
      </Box>
    );
  }

  if (connectionError || connectionStatus?.overall === "disconnected") {
    return (
      <Box textAlign="center" py={8}>
        <Text color="red.500">{connectionError || "Connection error. Please try refreshing the page."}</Text>
      </Box>
    );
  }

  if (availableQueues.length === 1) {
    redirect(`/course/${course_id}/office-hours/${availableQueues[0].id}`);
  }

  if (view === "browse") {
    return (
      <Box height={{ base: "auto", lg: "100%" }} minH={0} overflow={{ base: "visible", lg: "hidden" }}>
        <Flex direction={{ base: "column", lg: "row" }} gap={{ base: 4, lg: 6 }} align="stretch" height="100%" minH={0}>
          <Box flex={{ lg: 4 }} minW={0} overflowY={{ base: "visible", lg: "auto" }} minH={0}>
            <Stack spaceY={1}>
              {availableQueues.map((queue) => {
                const queueAssignments = activeAssignmentsByQueue[queue.id] || [];
                const openRequestCount = activeHelpRequests.filter((r) => r.help_queue === queue.id).length;
                return (
                  <QueueCard
                    key={queue.id}
                    queue={queue}
                    selected={queue.id === selectedQueueId}
                    onClickAction={() => {
                      const next = new URLSearchParams(searchParams.toString());
                      next.set("view", "browse");
                      next.set("queue", queue.id.toString());
                      router.replace(`/course/${course_id}/office-hours?${next.toString()}`, { scroll: false });
                    }}
                    openRequestCount={openRequestCount}
                    activeAssignments={queueAssignments}
                  />
                );
              })}
            </Stack>
          </Box>

          <Box flex={{ lg: 8 }} minW={0} minH={0} display="flex" flexDirection="column">
            <HStack justify="space-between" align="flex-start" mb="4" flexShrink={0}>
              <Box flex="1">
                <Heading size="md" mb="2">
                  {selectedQueueId
                    ? availableQueues.find((q) => q.id === selectedQueueId)?.name || "Select a queue"
                    : "Select a queue"}
                </Heading>
                {selectedQueueId && (
                  <Markdown>{availableQueues.find((q) => q.id === selectedQueueId)?.description || ""}</Markdown>
                )}
              </Box>
              {selectedQueueId && selectedQueue && (
                <>
                  <DialogRoot open={scheduleDialogOpen} onOpenChange={(e) => setScheduleDialogOpen(e.open)}>
                    <DialogContent maxW="6xl">
                      <DialogHeader>
                        <DialogTitle>{selectedQueue.name} - Weekly Schedule</DialogTitle>
                        <DialogCloseTrigger />
                      </DialogHeader>
                      <DialogBody>
                        <QueueWeeklySchedule
                          queueId={selectedQueue.id}
                          queueName={selectedQueue.name}
                          showTitle={false}
                        />
                      </DialogBody>
                    </DialogContent>
                  </DialogRoot>
                  <Button size="sm" variant="outline" onClick={() => setScheduleDialogOpen(true)}>
                    <Icon as={BsCalendar} mr={2} />
                    View Full Schedule
                  </Button>
                </>
              )}
            </HStack>

            {/* Upcoming Schedule Section */}
            {selectedQueueId && selectedQueue && (
              <Box
                borderWidth="1px"
                borderColor="border.emphasized"
                bg="bg.panel"
                rounded="md"
                p="4"
                mb="4"
                flexShrink={0}
              >
                <HStack justify="space-between" align="center" mb="3">
                  <HStack gap={2}>
                    <Icon as={BsClock} color="blue.500" />
                    <Heading size="sm">Upcoming Schedule</Heading>
                  </HStack>
                  {upcomingSchedule.length > 0 && (
                    <Link
                      as="button"
                      fontSize="sm"
                      color="blue.500"
                      fontWeight="medium"
                      onClick={() => setScheduleDialogOpen(true)}
                      _hover={{ textDecoration: "underline" }}
                    >
                      View full schedule →
                    </Link>
                  )}
                </HStack>
                {upcomingSchedule.length === 0 ? (
                  <Text fontSize="sm" color="fg.muted" fontStyle="italic">
                    No upcoming office hours scheduled for this queue.
                  </Text>
                ) : (
                  <VStack align="stretch" gap={2}>
                    {upcomingSchedule.map((event) => {
                      const eventStart = parseISO(event.start_time);
                      const eventEnd = parseISO(event.end_time);
                      const isToday = isSameDay(eventStart, new Date());
                      const dateStr = isToday ? "Today" : format(eventStart, "EEE, MMM d");
                      const timeStr = `${format(eventStart, "h:mm a")} - ${format(eventEnd, "h:mm a")}`;
                      const isCurrentlyHappening = isEventCurrentlyHappening(event.start_time, event.end_time, now);

                      return (
                        <Box
                          key={event.id}
                          p={3}
                          borderWidth={isCurrentlyHappening ? "2px" : "1px"}
                          borderColor={isCurrentlyHappening ? "green.500" : "border.muted"}
                          borderRadius="md"
                          bg={isCurrentlyHappening ? "green.subtle" : "bg.subtle"}
                          boxShadow={isCurrentlyHappening ? "0 0 0 2px rgba(34, 197, 94, 0.2)" : undefined}
                        >
                          <HStack justify="space-between" align="flex-start" gap={4}>
                            <VStack align="flex-start" gap={0.5} flex="1">
                              <HStack gap={2} align="center">
                                <Text fontSize="sm" fontWeight="medium">
                                  {event.organizer_name || event.title}
                                </Text>
                                {isCurrentlyHappening && (
                                  <Text fontSize="xs" color="green.600" fontWeight="semibold">
                                    🟢 Now
                                  </Text>
                                )}
                              </HStack>
                              <HStack gap={2} fontSize="xs" color="fg.muted">
                                <Text>{dateStr}</Text>
                                <Text>•</Text>
                                <Text>{timeStr}</Text>
                              </HStack>
                              {event.location && (
                                <Text fontSize="xs" color="fg.muted">
                                  📍 {event.location}
                                </Text>
                              )}
                            </VStack>
                          </HStack>
                        </Box>
                      );
                    })}
                  </VStack>
                )}
              </Box>
            )}

            <Box
              borderWidth="1px"
              borderColor="border.emphasized"
              bg="bg.panel"
              rounded="md"
              overflow="hidden"
              minH={0}
              display="flex"
              flexDirection="column"
              flex="1"
            >
              <Box px="4" py="2" borderBottomWidth="1px" borderColor="border.muted" bg="bg.subtle" flexShrink={0}>
                <Text fontWeight="semibold" fontSize="sm" color="fg.muted">
                  Open Requests
                </Text>
              </Box>
              <Box overflowY={{ base: "visible", lg: "auto" }} minH={0}>
                {selectedQueueId && selectedQueueRequests.length === 0 ? (
                  <Text px="4" py="3" color="fg.muted" fontSize="sm">
                    No open requests in this queue.
                  </Text>
                ) : selectedQueueId ? (
                  selectedQueueRequests.map((request) => {
                    const queue = availableQueues.find((q) => q.id === request.help_queue);
                    const students = requestStudentsMap[request.id] || [];
                    return (
                      <RequestRow
                        key={request.id}
                        request={request}
                        href={`/course/${course_id}/office-hours/${request.help_queue}/${request.id}`}
                        queue={queue}
                        students={students}
                      />
                    );
                  })
                ) : (
                  <Text px="4" py="3" color="fg.muted" fontSize="sm">
                    Select a queue to view requests.
                  </Text>
                )}
              </Box>
            </Box>
          </Box>
        </Flex>
      </Box>
    );
  }

  // My Requests view
  return (
    <Box height={{ base: "auto", lg: "100%" }} minH={0} overflow={{ base: "visible", lg: "hidden" }}>
      <Heading size="md" mb="4" flexShrink={0}>
        My Requests
      </Heading>

      <Box
        borderWidth="1px"
        borderColor="border.emphasized"
        bg="bg.panel"
        rounded="md"
        overflow="hidden"
        minH={0}
        display="flex"
        flexDirection="column"
      >
        <Box overflowY={{ base: "visible", lg: "auto" }} minH={0}>
          {groupedMyRequests.openRequests.length === 0 && groupedMyRequests.closedRequests.length === 0 ? (
            <Text px="4" py="3" color="fg.muted" fontSize="sm">
              You haven&apos;t created or participated in any help requests yet.
            </Text>
          ) : (
            <>
              {groupedMyRequests.openRequests.length > 0 && (
                <>
                  {groupedMyRequests.closedRequests.length > 0 && (
                    <Box px="4" py="2" bg="bg.subtle" borderBottomWidth="1px" borderColor="border.muted">
                      <Text fontWeight="semibold" fontSize="sm" color="fg.muted">
                        Open Requests
                      </Text>
                    </Box>
                  )}
                  {groupedMyRequests.openRequests.map((request) => {
                    const queue = availableQueues.find((q) => q.id === request.help_queue);
                    const students = requestStudentsMap[request.id] || [];
                    return (
                      <RequestRow
                        key={request.id}
                        request={request}
                        href={`/course/${course_id}/office-hours/${request.help_queue}/${request.id}`}
                        queue={queue}
                        students={students}
                      />
                    );
                  })}
                </>
              )}

              {groupedMyRequests.closedRequests.length > 0 && (
                <>
                  {groupedMyRequests.openRequests.length > 0 && (
                    <Box px="4" py="2" bg="bg.subtle" borderBottomWidth="1px" borderColor="border.muted">
                      <Text fontWeight="semibold" fontSize="sm" color="fg.muted">
                        Resolved/Closed Requests
                      </Text>
                    </Box>
                  )}
                  {groupedMyRequests.closedRequests.map((request) => {
                    const queue = availableQueues.find((q) => q.id === request.help_queue);
                    const students = requestStudentsMap[request.id] || [];
                    return (
                      <RequestRow
                        key={request.id}
                        request={request}
                        href={`/course/${course_id}/office-hours/${request.help_queue}/${request.id}`}
                        queue={queue}
                        students={students}
                      />
                    );
                  })}
                </>
              )}
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}
