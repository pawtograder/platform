"use client";

import { Box, Flex, Heading, HStack, Stack, Text, VStack } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import type { HelpQueueAssignment } from "@/utils/supabase/DatabaseTypes";
import { useParams } from "next/navigation";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import PersonAvatar from "@/components/ui/person-avatar";
import { BsPersonBadge } from "react-icons/bs";
import { useMemo } from "react";
import {
  useHelpQueues,
  useHelpQueueAssignments,
  useHelpRequests,
  useConnectionStatus,
  useOfficeHoursController
} from "@/hooks/useOfficeHoursRealtime";
import { Alert } from "@/components/ui/alert";
import { toaster } from "@/components/ui/toaster";
import { useCourseController } from "@/hooks/useCourseController";
import CalendarDayView from "@/components/calendar/calendar-day-view";
import { useOfficeHoursSchedule } from "@/hooks/useCalendarEvents";
import { format, parseISO, differenceInMinutes } from "date-fns";

/**
 * Dashboard component for instructors/TAs to manage their office-hour queues.
 * Shows all help queues in the current course, how many open requests each has,
 * who is currently working the queue, and allows the current user to start or
 * stop working that queue. Starting work creates a new `help_queue_assignments`
 * row; stopping work marks the active assignment as ended.
 *
 * Uses real-time updates to show live queue status and assignment changes.
 */
export default function HelpQueuesDashboard() {
  const { course_id } = useParams();
  const { course } = useCourseController();

  const { private_profile_id: taProfileId } = useClassProfiles();

  // Check if any calendar is configured
  const hasCalendar = !!(course?.office_hours_ics_url || course?.events_ics_url);

  // Get data using individual hooks
  const queues = useHelpQueues();
  const allQueueAssignments = useHelpQueueAssignments();
  const allHelpRequests = useHelpRequests();
  const { isConnected, connectionStatus } = useConnectionStatus();
  const officeHoursEvents = useOfficeHoursSchedule();

  // Filter assignments for current TA
  const activeAssignments = useMemo(() => {
    return allQueueAssignments.filter((assignment) => assignment.ta_profile_id === taProfileId && assignment.is_active);
  }, [allQueueAssignments, taProfileId]);

  // Filter unresolved requests (activeHelpRequests gives us open/in_progress, but we also need to check for resolved_by)
  const unresolvedRequests = useMemo(() => {
    return allHelpRequests.filter((request) => request.status !== "resolved" && request.status !== "closed");
  }, [allHelpRequests]);

  // Group all active assignments by queue (used for display)
  const activeAssignmentsByQueue = useMemo(() => {
    const assignments = allQueueAssignments.filter((assignment) => assignment.is_active);

    return assignments.reduce(
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
  }, [allQueueAssignments]);

  // Sort queues always by ordinal
  const sortedQueues = useMemo(() => {
    return [...queues].sort((a, b) => {
      // Primary sort: by ordinal
      if (a.ordinal !== b.ordinal) {
        return a.ordinal - b.ordinal;
      }
      // Secondary sort: alphabetically by name
      return a.name.localeCompare(b.name);
    });
  }, [queues]);

  // Calculate staffing information for each queue
  const queueStaffingInfo = useMemo(() => {
    const now = new Date();
    const info: Record<
      number,
      {
        currentStaffUntil: Date | null;
        nextScheduledStart: Date | null;
        nextScheduledTimeStr: string | null;
        groupedAssignments: HelpQueueAssignment[][];
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

      // Group overlapping assignments
      // Since all assignments in queueAssignments are active (is_active = true),
      // they're all currently overlapping, so group them all together
      const groupedAssignments: HelpQueueAssignment[][] = queueAssignments.length > 0 ? [queueAssignments] : [];

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

  // Get table controllers from office hours controller
  const controller = useOfficeHoursController();
  const { helpQueueAssignments } = controller;

  const handleStartWorking = async (queueId: number) => {
    try {
      await helpQueueAssignments.create({
        class_id: Number(course_id),
        help_queue_id: queueId,
        ta_profile_id: taProfileId,
        is_active: true,
        started_at: new Date().toISOString(),
        ended_at: null,
        max_concurrent_students: 1
      });

      toaster.success({
        title: "Success",
        description: "Started working on queue"
      });
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to start working on queue: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  const handleStopWorking = async (assignmentId: number) => {
    try {
      await helpQueueAssignments.update(assignmentId, {
        is_active: false,
        ended_at: new Date().toISOString()
      });

      toaster.success({
        title: "Success",
        description: "Stopped working on queue"
      });
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to stop working on queue: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  return (
    <Stack spaceY="4" height="100%" overflowY="auto">
      {/* Connection Status Indicator */}
      {!isConnected && (
        <Alert status="warning" title="Real-time updates disconnected">
          Queue status may not be up to date. Connection status: {connectionStatus?.overall}
        </Alert>
      )}

      {/* Today's Calendar Schedule - only show if calendar is configured */}
      {hasCalendar && (
        <Box>
          <CalendarDayView />
        </Box>
      )}

      {/* Queue Management Section */}
      <Heading size="sm" mt={hasCalendar ? 4 : 0}>
        Help Queues
      </Heading>

      {sortedQueues.map((queue) => {
        const myAssignment = activeAssignments.find((a) => a.help_queue_id === queue.id);
        const queueAssignments = activeAssignmentsByQueue[queue.id] || [];
        const staffingInfo = queueStaffingInfo[queue.id] || {
          currentStaffUntil: null,
          nextScheduledStart: null,
          nextScheduledTimeStr: null,
          groupedAssignments: []
        };

        return (
          <Flex
            key={queue.id}
            p={4}
            borderWidth="1px"
            borderRadius="md"
            alignItems="flex-start"
            justifyContent="space-between"
            role="region"
            aria-label={`Help queue: ${queue.name}`}
          >
            <Box flex={1}>
              <Text fontWeight="medium">{queue.name}</Text>
              <HStack spaceX="2" mt="1">
                <Text fontSize="sm">Mode:</Text>
                <Text fontSize="sm">{queue.queue_type}</Text>
                <Text fontSize="sm">
                  · Open Requests: {unresolvedRequests.filter((r) => r.help_queue === queue.id).length}
                </Text>
                {!queue.is_active && (
                  <Text fontSize="sm" color="red.500">
                    · Inactive
                  </Text>
                )}
              </HStack>

              {/* Staffing information */}
              <VStack align="stretch" spaceY={2} mt={3}>
                {queueAssignments.length > 0 ? (
                  <>
                    {/* Show grouped assignments */}
                    {staffingInfo.groupedAssignments.map((group, groupIndex) => {
                      const groupStaffIds = group.map((a) => a.ta_profile_id);
                      const groupEnd = staffingInfo.currentStaffUntil;

                      return (
                        <Box key={`group-${groupIndex}`}>
                          <HStack align="center" spaceX={2} mb={1}>
                            <BsPersonBadge />
                            <Text fontSize="sm" fontWeight="medium">
                              Staff on duty ({groupStaffIds.length})
                            </Text>
                          </HStack>
                          <HStack wrap="wrap" gap={2} mb={1}>
                            {groupStaffIds.map((staffId: string, index: number) => (
                              <PersonAvatar key={`staff-${staffId}-${index}`} uid={staffId} size="sm" />
                            ))}
                          </HStack>
                          {groupEnd && (
                            <Text fontSize="xs" color="gray.600">
                              Until {format(groupEnd, "h:mm a")}
                              {differenceInMinutes(groupEnd, new Date()) > 0 && (
                                <Text as="span" ml={1}>
                                  ({Math.floor(differenceInMinutes(groupEnd, new Date()) / 60)}h{" "}
                                  {differenceInMinutes(groupEnd, new Date()) % 60}m remaining)
                                </Text>
                              )}
                            </Text>
                          )}
                        </Box>
                      );
                    })}

                    {/* Show next scheduled staff if current assignments will end */}
                    {staffingInfo.currentStaffUntil && staffingInfo.nextScheduledTimeStr && (
                      <Text fontSize="xs" color="gray.600" mt={1}>
                        Next staff: {staffingInfo.nextScheduledTimeStr}
                      </Text>
                    )}
                  </>
                ) : (
                  <>
                    <HStack align="center" spaceX={2}>
                      <BsPersonBadge />
                      <Text fontSize="sm" fontWeight="medium">
                        Staff on duty (0)
                      </Text>
                    </HStack>
                    <Text fontSize="xs" color="gray.600">
                      No staff currently on duty
                    </Text>
                    {staffingInfo.nextScheduledTimeStr && (
                      <Text fontSize="xs" color="gray.600" mt={1}>
                        Next staff: {staffingInfo.nextScheduledTimeStr}
                      </Text>
                    )}
                  </>
                )}
              </VStack>
            </Box>
            <Box ml={4}>
              {myAssignment ? (
                <Button colorPalette="red" onClick={() => handleStopWorking(myAssignment.id)}>
                  Stop Working
                </Button>
              ) : (
                <Button colorPalette="green" onClick={() => handleStartWorking(queue.id)}>
                  Start Working
                </Button>
              )}
            </Box>
          </Flex>
        );
      })}
      {queues.length === 0 && <Text>No help queues configured for this course.</Text>}
    </Stack>
  );
}
