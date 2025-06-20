"use client";
import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useList, useCreate, useUpdate } from "@refinedev/core";
import type { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { useParams } from "next/navigation";
import { useClassProfiles } from "@/hooks/useClassProfiles";

/**
 * Dashboard component for instructors/TAs to manage their office-hour queues.
 * Shows all help queues in the current course, how many open requests each has,
 * who is currently working the queue, and allows the current user to start or
 * stop working that queue. Starting work creates a new `help_queue_assignments`
 * row; stopping work marks the active assignment as ended.
 */
export default function HelpQueuesDashboard() {
  const { course_id } = useParams();

  const { private_profile_id: taProfileId } = useClassProfiles();

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
  const { data: assignmentsResponse } = useList<{ id: number; help_queue_id: number; is_active: boolean }>({
    resource: "help_queue_assignments",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "ta_profile_id", operator: "eq", value: taProfileId },
      { field: "is_active", operator: "eq", value: true }
    ],
    pagination: { current: 1, pageSize: 100 }
  });

  // Fetch all unresolved help requests for this course to display queue workload counts.
  const { data: requestsResponse } = useList<HelpRequest>({
    resource: "help_requests",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    pagination: { current: 1, pageSize: 1000 }
  });

  const activeAssignments = assignmentsResponse?.data ?? [];
  const unresolvedRequests = (requestsResponse?.data ?? []).filter((r) => r.resolved_by === null);

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
      }
    });
  };

  if (queuesLoading) return <Text>Loading office-hour queues…</Text>;
  if (queuesError) return <Text>Error: {queuesError.message}</Text>;

  const queues = queuesResponse?.data ?? [];

  return (
    <Stack spaceY="4">
      {queues.map((queue) => {
        const myAssignment = activeAssignments.find((a) => a.help_queue_id === queue.id);
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
                <Text fontSize="sm" color="fg.subtle">
                  Mode:
                </Text>
                <Text fontSize="sm">{queue.queue_type}</Text>
                <Text fontSize="sm" color="fg.subtle">
                  · Open Requests: {unresolvedRequests.filter((r) => r.help_queue === queue.id).length}
                </Text>
              </HStack>
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
