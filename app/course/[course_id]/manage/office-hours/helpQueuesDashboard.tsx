"use client";
import { Box, Flex, HStack, Stack, Text, VStack } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useList, useCreate, useUpdate } from "@refinedev/core";
import type { HelpQueue, HelpRequest, HelpQueueAssignment } from "@/utils/supabase/DatabaseTypes";
import { useParams } from "next/navigation";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import PersonAvatar from "@/components/ui/person-avatar";
import { BsPersonBadge } from "react-icons/bs";
import { useMemo } from "react";
import { useOfficeHoursRealtime } from "@/hooks/useOfficeHoursRealtime";
import { Alert } from "@/components/ui/alert";

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

  const { private_profile_id: taProfileId } = useClassProfiles();

  // Set up real-time subscriptions for global help queues and assignments
  const {
    data: realtimeData,
    isConnected,
    connectionStatus,
    isLoading: realtimeLoading
  } = useOfficeHoursRealtime({
    classId: Number(course_id),
    enableGlobalQueues: true,
    enableStaffData: false // Not needed for dashboard
  });

  // Fetch all help queues for the course.
  const {
    data: queuesResponse,
    isLoading: queuesLoading,
    error: queuesError
  } = useList<HelpQueue>({
    resource: "help_queues",
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  // Fetch all active assignments for this TA across queues in this course.
  const { data: assignmentsResponse } = useList<{
    id: number;
    help_queue_id: number;
    is_active: boolean;
  }>({
    resource: "help_queue_assignments",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "ta_profile_id", operator: "eq", value: taProfileId },
      { field: "is_active", operator: "eq", value: true }
    ],
    pagination: { current: 1, pageSize: 100 }
  });

  // Fetch ALL active assignments for all staff members in this course
  const {
    data: allActiveAssignments,
    isLoading: activeAssignmentsLoading,
    error: activeAssignmentsError
  } = useList<HelpQueueAssignment>({
    resource: "help_queue_assignments",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "is_active", operator: "eq", value: true }
    ],
    sorters: [{ field: "started_at", order: "asc" }],
    pagination: { pageSize: 1000 }
  });

  // Fetch all unresolved help requests for this course to display queue workload counts.
  const { data: requestsResponse } = useList<HelpRequest>({
    resource: "help_requests",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    pagination: { current: 1, pageSize: 1000 }
  });

  // Use realtime data when available, fallback to API data
  const queues = realtimeData.helpQueues.length > 0 ? realtimeData.helpQueues : (queuesResponse?.data ?? []);
  const queueAssignments = useMemo(() => {
    return realtimeData.helpQueueAssignments.length > 0
      ? realtimeData.helpQueueAssignments
      : (allActiveAssignments?.data ?? []);
  }, [realtimeData.helpQueueAssignments, allActiveAssignments?.data]);

  const activeAssignments = assignmentsResponse?.data ?? [];
  const unresolvedRequests = (requestsResponse?.data ?? []).filter((r) => r.resolved_by === null);

  // Group all active assignments by queue
  const activeAssignmentsByQueue = useMemo(() => {
    const assignments = queueAssignments.filter((assignment) => assignment.is_active);

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
  }, [queueAssignments]);

  const { mutate: createAssignment } = useCreate();
  const { mutate: updateAssignment } = useUpdate();

  const handleStartWorking = (queueId: number) => {
    createAssignment({
      resource: "help_queue_assignments",
      values: {
        class_id: Number(course_id),
        help_queue_id: queueId,
        ta_profile_id: taProfileId,
        is_active: true,
        started_at: new Date().toISOString()
      },
      successNotification: {
        message: "Started working on queue",
        type: "success"
      }
    });
  };

  const handleStopWorking = (assignmentId: number) => {
    updateAssignment({
      resource: "help_queue_assignments",
      id: assignmentId,
      values: {
        is_active: false,
        ended_at: new Date().toISOString()
      },
      successNotification: {
        message: "Stopped working on queue",
        type: "success"
      }
    });
  };

  if (queuesLoading || activeAssignmentsLoading || realtimeLoading) {
    return <Text>Loading office-hour queues…</Text>;
  }

  if (queuesError) return <Text>Error: {queuesError.message}</Text>;
  if (activeAssignmentsError) return <Text>Error loading assignments: {activeAssignmentsError.message}</Text>;

  return (
    <Stack spaceY="4">
      {/* Connection Status Indicator */}
      {!isConnected && (
        <Alert status="warning" title="Real-time updates disconnected">
          Queue status may not be up to date. Connection status: {connectionStatus?.overall}
        </Alert>
      )}

      {queues.map((queue) => {
        const myAssignment = activeAssignments.find((a) => a.help_queue_id === queue.id);
        const queueAssignments = activeAssignmentsByQueue[queue.id] || [];
        const activeStaff = queueAssignments.map((assignment: HelpQueueAssignment) => assignment.ta_profile_id);

        return (
          <Flex
            key={queue.id}
            p={4}
            borderWidth="1px"
            borderRadius="md"
            alignItems="center"
            justifyContent="space-between"
          >
            <Box>
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

              {/* Active staff section */}
              <VStack align="stretch" spaceY={2} mt={2}>
                <HStack align="center" spaceX={2}>
                  <BsPersonBadge />
                  <Text fontSize="sm" fontWeight="medium">
                    Staff on duty ({activeStaff.length})
                  </Text>
                  {isConnected && (
                    <Text fontSize="xs" color="green.500">
                      ● Live
                    </Text>
                  )}
                </HStack>

                {activeStaff.length > 0 ? (
                  <HStack wrap="wrap" gap={2}>
                    {activeStaff.slice(0, 4).map((staffId: string, index: number) => (
                      <PersonAvatar key={`staff-${staffId}-${index}`} uid={staffId} size="sm" />
                    ))}
                    {activeStaff.length > 4 && <Text fontSize="xs">+{activeStaff.length - 4} more</Text>}
                  </HStack>
                ) : (
                  <Text fontSize="xs">No staff currently on duty</Text>
                )}
              </VStack>
            </Box>
            {myAssignment ? (
              <Button variant="outline" colorPalette="red" onClick={() => handleStopWorking(myAssignment.id)}>
                Stop Working
              </Button>
            ) : (
              <Button colorPalette="green" onClick={() => handleStartWorking(queue.id)}>
                Start Working
              </Button>
            )}
          </Flex>
        );
      })}
      {queues.length === 0 && <Text>No help queues configured for this course.</Text>}
    </Stack>
  );
}
