"use client";

import { PostRow } from "@/components/discussion/PostRow";
import { QueueCard } from "@/components/help-queue/queue-card";
import { RequestRow } from "@/components/help-queue/request-row";
import {
  DrawerBackdrop,
  DrawerBody,
  DrawerCloseTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerRoot,
  DrawerTitle
} from "@/components/ui/drawer";
import { useActiveHelpRequest } from "@/hooks/useActiveHelpRequest";
import { useOfficeHoursSchedule } from "@/hooks/useCalendarEvents";
import { useCourseController, useDiscussionThreadTeasers, useDiscussionTopics } from "@/hooks/useCourseController";
import {
  useHelpQueueAssignments,
  useHelpQueues,
  useHelpRequests,
  useHelpRequestStudents
} from "@/hooks/useOfficeHoursRealtime";
import { Accordion, Badge, Box, Button, Heading, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { differenceInMinutes, format, parseISO } from "date-fns";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BsCalendar, BsChatText } from "react-icons/bs";
import { FaPlus } from "react-icons/fa";
import Markdown from "react-markdown";

interface HelpDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

function HelpDrawer({ isOpen, onClose }: HelpDrawerProps) {
  const { course_id } = useParams();
  const courseId = Number(course_id);
  const router = useRouter();
  const activeRequest = useActiveHelpRequest();

  const allHelpQueues = useHelpQueues();
  const allHelpQueueAssignments = useHelpQueueAssignments();
  const allHelpRequests = useHelpRequests();
  const helpRequestStudents = useHelpRequestStudents();
  const threads = useDiscussionThreadTeasers();
  const topics = useDiscussionTopics();
  const officeHoursEvents = useOfficeHoursSchedule();
  const courseController = useCourseController();

  const [selectedQueueId, setSelectedQueueId] = useState<number | null>(null);

  // Filter to available queues
  const helpQueues = allHelpQueues.filter((queue) => queue.available);

  // Filter to active assignments
  const activeAssignments = allHelpQueueAssignments.filter((assignment) => assignment.is_active);

  // Get active help requests
  const activeHelpRequests = allHelpRequests.filter(
    (request) => request.status === "open" || request.status === "in_progress"
  );

  // Group active assignments by queue
  const activeAssignmentsByQueue = useMemo(() => {
    return activeAssignments.reduce(
      (acc, assignment) => {
        const queueId = assignment.help_queue_id;
        if (!acc[queueId]) {
          acc[queueId] = [];
        }
        acc[queueId].push(assignment);
        return acc;
      },
      {} as Record<number, typeof activeAssignments>
    );
  }, [activeAssignments]);

  // Sort all queues by ordinal (always)
  const sortedQueues = useMemo(() => {
    return [...helpQueues].sort((a, b) => {
      // Primary sort: by ordinal
      if (a.ordinal !== b.ordinal) {
        return a.ordinal - b.ordinal;
      }
      // Secondary sort: alphabetically by name
      return a.name.localeCompare(b.name);
    });
  }, [helpQueues]);

  // Calculate staffing information for each queue
  const queueStaffingInfo = useMemo(() => {
    const now = new Date();
    const info: Record<
      number,
      {
        currentStaffUntil: Date | null;
        nextScheduledStart: Date | null;
        nextScheduledTimeStr: string | null;
        groupedAssignments: (typeof activeAssignments)[];
      }
    > = {};

    sortedQueues.forEach((queue) => {
      const queueAssignments = activeAssignmentsByQueue[queue.id] || [];

      // Find calendar events for this queue
      const queueEvents = officeHoursEvents.filter(
        (event) =>
          event.resolved_help_queue_id === queue.id ||
          (event.resolved_help_queue_id === null &&
            event.queue_name &&
            event.queue_name.toLowerCase() === queue.name.toLowerCase())
      );

      // Group overlapping assignments - all active assignments are currently overlapping
      const groupedAssignments: (typeof activeAssignments)[] =
        queueAssignments.length > 0 ? [queueAssignments] : [];

      // Find when current staffing will end
      // Only show end time if there's a calendar event currently happening
      let currentStaffUntil: Date | null = null;

      if (queueAssignments.length > 0) {
        // Find calendar events that are currently happening
        const currentEvents = queueEvents.filter((event) => {
          const eventStart = parseISO(event.start_time);
          const eventEnd = parseISO(event.end_time);
          return eventStart <= now && eventEnd >= now;
        });

        if (currentEvents.length > 0) {
          // Use the latest end time from current events
          currentStaffUntil = parseISO(
            currentEvents.reduce((latest, event) => {
              const eventEnd = parseISO(event.end_time);
              const latestEnd = latest ? parseISO(latest) : null;
              return !latestEnd || eventEnd > latestEnd ? event.end_time : latest;
            }, null as string | null) || currentEvents[0].end_time
          );
        }
        // If no current event, don't set currentStaffUntil - we don't know when it ends
      }

      // Find next scheduled staff start time (after current assignments end or now if no current staffing)
      const searchStartTime = currentStaffUntil || now;
      const nextScheduledEvents = queueEvents
        .filter((event) => {
          const eventStart = parseISO(event.start_time);
          // Only show events that start after current staffing ends (or now if no current staffing)
          return eventStart.getTime() > searchStartTime.getTime();
        })
        .sort((a, b) => {
          const aStart = parseISO(a.start_time);
          const bStart = parseISO(b.start_time);
          return aStart.getTime() - bStart.getTime();
        });

      let nextScheduledStart: Date | null = null;
      let nextScheduledTimeStr: string | null = null;

      if (nextScheduledEvents.length > 0) {
        nextScheduledStart = parseISO(nextScheduledEvents[0].start_time);
        nextScheduledTimeStr = format(nextScheduledStart, "EEE, MMM d 'at' h:mm a");
      }

      info[queue.id] = {
        currentStaffUntil,
        nextScheduledStart,
        nextScheduledTimeStr,
        groupedAssignments
      };
    });

    return info;
  }, [sortedQueues, activeAssignmentsByQueue, officeHoursEvents]);

  // Get requests for selected queue
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

  // Get pinned discussion threads
  const pinnedThreads = useMemo(() => {
    if (!threads || !topics) return [];
    return threads
      .filter((t) => t.pinned && t.class_id === courseId && !t.draft && !t.instructors_only)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 5); // Limit to 5 pinned posts
  }, [threads, topics, courseId]);

  // Auto-select first queue with active staff if none selected, or update selection if current queue loses active staff
  useEffect(() => {
    // Get all queues with active staff
    const queuesWithActiveStaff = sortedQueues.filter(
      (queue) => (activeAssignmentsByQueue[queue.id]?.length ?? 0) > 0
    );

    if (!selectedQueueId) {
      // No selection: select first queue with active staff
      if (queuesWithActiveStaff.length > 0) {
        setSelectedQueueId(queuesWithActiveStaff[0].id);
      }
    } else {
      // Check if current selection still has active staff
      const currentQueueHasActiveStaff = queuesWithActiveStaff.some(
        (queue) => queue.id === selectedQueueId
      );
      if (!currentQueueHasActiveStaff) {
        // Current selection lost active staff: update to first available or null
        setSelectedQueueId(queuesWithActiveStaff.length > 0 ? queuesWithActiveStaff[0].id : null);
      }
    }
  }, [selectedQueueId, sortedQueues, activeAssignmentsByQueue]);

  const handleNewRequest = (queueId: number) => {
    router.push(`/course/${course_id}/office-hours/${queueId}/new`);
    onClose();
  };

  const handleViewQueue = (queueId: number) => {
    // Validate queueId to prevent navigation to invalid queues
    if (!queueId || queueId === 0) {
      // Navigate to browse view when queueId is invalid
      router.push(`/course/${course_id}/office-hours?view=browse`);
      onClose();
      return;
    }
    router.push(`/course/${course_id}/office-hours?view=browse&queue=${queueId}`);
    onClose();
  };

  const handleViewQueueOrBrowse = () => {
    if (helpQueues.length > 0 && helpQueues[0]) {
      handleViewQueue(helpQueues[0].id);
    } else {
      // Navigate to browse view when no queues are available
      router.push(`/course/${course_id}/office-hours?view=browse`);
      onClose();
    }
  };

  const handleViewRequest = (queueId: number, requestId: number) => {
    router.push(`/course/${course_id}/office-hours/${queueId}/${requestId}`);
    onClose();
  };

  return (
    <DrawerRoot open={isOpen} onOpenChange={(e) => !e.open && onClose()} size="md" placement="end">
      <DrawerBackdrop />
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Get Help</DrawerTitle>
          <DrawerCloseTrigger />
        </DrawerHeader>
        <DrawerBody>
          <Stack spaceY={4}>
            {/* Office Hours Description */}
            {courseController?.course?.office_hours_description && (
              <Box p={4} borderWidth="1px" borderColor="border.muted" bg="bg.subtle" rounded="md">
                <Text fontSize="sm" fontWeight="medium" mb={2} color="fg.muted">
                  About Office Hours
                </Text>
                <Box fontSize="sm" color="fg.muted">
                  <Markdown>{courseController.course.office_hours_description}</Markdown>
                </Box>
              </Box>
            )}

            {/* Pinned Discussion Posts */}
            {pinnedThreads.length > 0 && (
              <Accordion.Root defaultValue={[]} collapsible>
                <Accordion.Item value="pinned-posts">
                  <Accordion.ItemTrigger>
                    <HStack justify="space-between" w="100%">
                      <HStack gap={2}>
                        <Icon as={BsChatText} color="blue.500" />
                        <Heading size="sm">Pinned Discussion Posts</Heading>
                        <Badge colorPalette="blue" variant="subtle" size="sm">
                          {pinnedThreads.length}
                        </Badge>
                      </HStack>
                      <Accordion.ItemIndicator />
                    </HStack>
                  </Accordion.ItemTrigger>
                  <Accordion.ItemContent>
                    <Box pt={3}>
                      <Text fontSize="sm" color="fg.muted" mb={3}>
                        Browse these pinned posts or post your own question on the discussion board. For live help, use
                        office hours below.
                      </Text>
                      <Stack spaceY={1} mb={3}>
                        {pinnedThreads.map((thread) => (
                          <PostRow
                            key={thread.id}
                            threadId={thread.id}
                            href={`/course/${courseId}/discussion/${thread.id}`}
                            variant="compact"
                            showTopicBadge={true}
                          />
                        ))}
                      </Stack>
                      <Button asChild variant="outline" size="sm" w="100%">
                        <Link href={`/course/${courseId}/discussion`}>Browse All Discussion Posts</Link>
                      </Button>
                    </Box>
                  </Accordion.ItemContent>
                </Accordion.Item>
              </Accordion.Root>
            )}

            {/* Active Request Status */}
            {activeRequest && (
              <Box p={4} borderWidth="1px" borderColor="border.emphasized" bg="bg.subtle" rounded="md">
                <HStack justify="space-between" mb={2}>
                  <Text fontWeight="semibold">Your Active Request</Text>
                  <Badge
                    colorPalette={activeRequest.request.status === "in_progress" ? "orange" : "blue"}
                    variant="solid"
                  >
                    {activeRequest.request.status === "in_progress" ? "In Progress" : "Open"}
                  </Badge>
                </HStack>
                <Text fontSize="sm" color="fg.muted" mb={3}>
                  Position #{activeRequest.queuePosition} in {activeRequest.queueName}
                </Text>
                <Button
                  size="sm"
                  onClick={() => handleViewRequest(activeRequest.request.help_queue, activeRequest.request.id)}
                >
                  View Request
                </Button>
              </Box>
            )}

            {/* Queue Status */}
            <Box>
              <Heading size="md" mb={3}>
                 Chat with course staff live!
              </Heading>
              {sortedQueues.length === 0 ? (
                <Box p={4} borderWidth="1px" borderColor="border.muted" rounded="md" bg="bg.panel">
                  <Text color="fg.muted" mb={3}>
                    No queues configured for this course.
                  </Text>
                </Box>
              ) : (
                <Stack spaceY={2}>
                  {sortedQueues.map((queue) => {
                    const queueAssignments = activeAssignmentsByQueue[queue.id] || [];
                    const openRequestCount = activeHelpRequests.filter((r) => r.help_queue === queue.id).length;
                    const isSelected = selectedQueueId === queue.id;
                    const queueRequests = activeHelpRequests.filter((r) => r.help_queue === queue.id);
                    const publicRequests = queueRequests.filter((r) => !r.is_private);
                    const staffingInfo = queueStaffingInfo[queue.id] || {
                      currentStaffUntil: null,
                      nextScheduledStart: null,
                      nextScheduledTimeStr: null,
                      groupedAssignments: []
                    };
                    const hasActiveStaff = queueAssignments.length > 0;

                    return (
                      <Box
                        key={queue.id}
                        p={3}
                        borderWidth="1px"
                        borderColor={isSelected ? "border.emphasized" : "border.muted"}
                        bg={isSelected ? "bg.muted" : "bg.panel"}
                        rounded="md"
                        opacity={!hasActiveStaff ? 0.6 : 1}
                      >
                        <QueueCard
                          queue={queue}
                          selected={isSelected}
                          onClickAction={() => setSelectedQueueId(isSelected ? null : queue.id)}
                          openRequestCount={openRequestCount}
                          activeAssignments={queueAssignments}
                        />
                        <Box mt={3} pl={2}>
                          {/* Staffing information */}
                          {hasActiveStaff ? (
                            <>
                              {staffingInfo.groupedAssignments.map((group, groupIndex) => {
                                const groupEnd = staffingInfo.currentStaffUntil;
                                return (
                                  <Box key={`group-${groupIndex}`} mb={2}>
                                    {groupEnd && (
                                      <HStack gap={2} align="center" mb={1}>
                                        <Icon as={BsCalendar} fontSize="xs" color="fg.muted" />
                                        <Text fontSize="xs" color="fg.muted">
                                          Until {format(groupEnd, "h:mm a")}
                                          {differenceInMinutes(groupEnd, new Date()) > 0 && (
                                            <Text as="span" ml={1}>
                                              ({Math.floor(differenceInMinutes(groupEnd, new Date()) / 60)}h{" "}
                                              {differenceInMinutes(groupEnd, new Date()) % 60}m remaining)
                                            </Text>
                                          )}
                                        </Text>
                                      </HStack>
                                    )}
                                    {staffingInfo.nextScheduledTimeStr && (
                                      <Text fontSize="xs" color="fg.muted" mb={2}>
                                        Next staff: {staffingInfo.nextScheduledTimeStr}
                                      </Text>
                                    )}
                                  </Box>
                                );
                              })}
                            </>
                          ) : (
                            <>
                              <Text fontSize="sm" color="fg.muted" mb={2}>
                                This queue is not currently staffed.
                              </Text>
                              {staffingInfo.nextScheduledTimeStr ? (
                                <HStack gap={2} mb={2} align="center">
                                  <Icon as={BsCalendar} fontSize="xs" color="fg.muted" />
                                  <Text fontSize="sm" color="fg.muted">
                                    Next scheduled: {staffingInfo.nextScheduledTimeStr}
                                  </Text>
                                </HStack>
                              ) : (
                                <Text fontSize="sm" color="fg.muted" mb={2}>
                                  No upcoming schedule found.
                                </Text>
                              )}
                            </>
                          )}

                          {/* Action buttons */}
                          {hasActiveStaff ? (
                            <HStack gap={2} mb={isSelected && queueRequests.length > 0 && !queue.is_demo ? 3 : 0}>
                              <Button size="sm" colorPalette="green" onClick={() => handleNewRequest(queue.id)}>
                                <FaPlus />
                                New Request
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => handleViewQueue(queue.id)}>
                                View Full Queue
                              </Button>
                            </HStack>
                          ) : (
                            <Button
                              asChild
                              size="sm"
                              variant="outline"
                              onClick={(e) => {
                                e.stopPropagation();
                                router.push(`/course/${courseId}/office-hours?view=browse&queue=${queue.id}`);
                                onClose();
                              }}
                            >
                              <Link href={`/course/${courseId}/office-hours?view=browse&queue=${queue.id}`}>
                                View Queue
                              </Link>
                            </Button>
                          )}

                          {/* Selected queue requests */}
                          {isSelected && publicRequests.length > 0 && !queue.is_demo && (
                            <Box>
                              <Text fontSize="sm" fontWeight="medium" mb={2} color="fg.muted">
                                Public Open Requests ({publicRequests.length})
                              </Text>
                              <Stack spaceY={1}>
                                {publicRequests.slice(0, 5).map((request) => {
                                  const students = requestStudentsMap[request.id] || [];
                                  const requestHref = `/course/${course_id}/office-hours/${request.help_queue}/${request.id}`;
                                  return (
                                    <Box
                                      key={request.id}
                                      p={2}
                                      borderWidth="1px"
                                      borderColor="border.muted"
                                      rounded="md"
                                    >
                                      <RequestRow request={request} href={requestHref} queue={queue} students={students} />
                                    </Box>
                                  );
                                })}
                                {publicRequests.length > 5 && (
                                  <Text fontSize="xs" color="fg.muted" textAlign="center" mt={1}>
                                    ...and {publicRequests.length - 5} more
                                  </Text>
                                )}
                              </Stack>
                            </Box>
                          )}
                        </Box>
                      </Box>
                    );
                  })}
                  <Box pt={2}>
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      w="100%"
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/course/${courseId}/office-hours`);
                        onClose();
                      }}
                    >
                      <Link href={`/course/${courseId}/office-hours`}>
                        <Icon as={BsCalendar} mr={2} />
                        View Full Schedule
                      </Link>
                    </Button>
                  </Box>
                </Stack>
              )}
            </Box>
          </Stack>
        </DrawerBody>
      </DrawerContent>
    </DrawerRoot>
  );
}

export default HelpDrawer;
export { HelpDrawer };
