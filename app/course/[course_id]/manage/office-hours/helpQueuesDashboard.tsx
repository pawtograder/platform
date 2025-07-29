"use client";

import { Box, Flex, HStack, Stack, Text, VStack } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useCreate, useUpdate } from "@refinedev/core";
import type { HelpQueueAssignment } from "@/utils/supabase/DatabaseTypes";
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

  // Set up real-time subscriptions for all office hours data
  const { data, isConnected, connectionStatus, isLoading } = useOfficeHoursRealtime({
    classId: Number(course_id),
    enableGlobalQueues: true,
    enableActiveRequests: true,
    enableStaffData: false // Not needed for dashboard
  });

  // Extract data from realtime hook
  const queues = data.helpQueues;
  const allQueueAssignments = data.helpQueueAssignments;
  const allHelpRequests = data.activeHelpRequests;

  // Filter assignments for current TA
  const activeAssignments = useMemo(() => {
    return allQueueAssignments.filter((assignment) => assignment.ta_profile_id === taProfileId && assignment.is_active);
  }, [allQueueAssignments, taProfileId]);

  // Filter unresolved requests (activeHelpRequests gives us open/in_progress, but we also need to check for resolved_by)
  const unresolvedRequests = useMemo(() => {
    return allHelpRequests.filter((request) => request.resolved_by === null);
  }, [allHelpRequests]);

  // Group all active assignments by queue
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

  if (isLoading) {
    return <Text>Loading office-hour queues…</Text>;
  }

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
            role="region"
            aria-label={`Help queue: ${queue.name}`}
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
              <Button colorPalette="red" onClick={() => handleStopWorking(myAssignment.id)}>
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
