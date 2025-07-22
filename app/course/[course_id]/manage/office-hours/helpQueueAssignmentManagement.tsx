"use client";

import { Box, Flex, HStack, Stack, Text, Heading, Icon, Badge } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useList, useUpdate, useDelete } from "@refinedev/core";
import { useParams } from "next/navigation";
import { BsPerson, BsCalendar, BsStopwatch, BsX } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";
import { Alert } from "@/components/ui/alert";
import { useOfficeHoursRealtime } from "@/hooks/useOfficeHoursRealtime";
import { useEffect } from "react";
import type { HelpQueueAssignment, HelpQueue, UserProfile } from "@/utils/supabase/DatabaseTypes";

type AssignmentWithDetails = HelpQueueAssignment & {
  help_queue?: HelpQueue;
  profile?: UserProfile;
};

/**
 * Component for managing help queue assignments.
 * Allows instructors to view and manage TA assignments across all queues.
 * Uses real-time updates to show assignment changes immediately.
 */
export default function HelpQueueAssignmentManagement() {
  const { course_id } = useParams();

  // Set up real-time subscriptions for global help queues and assignments
  const {
    data: realtimeData,
    isConnected,
    connectionStatus,
    isLoading: realtimeLoading
  } = useOfficeHoursRealtime({
    classId: Number(course_id),
    enableGlobalQueues: true,
    enableStaffData: false
  });

  // Fetch all assignments for the course with related data
  const {
    data: assignmentsResponse,
    isLoading: assignmentsLoading,
    error: assignmentsError,
    refetch: refetchAssignments
  } = useList<AssignmentWithDetails>({
    resource: "help_queue_assignments",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    sorters: [
      { field: "is_active", order: "desc" },
      { field: "started_at", order: "desc" }
    ],
    meta: {
      select: `
        *,
        help_queue:help_queue_id(*),
        profile:ta_profile_id(*)
      `
    }
  });

  const { mutate: updateAssignment } = useUpdate();
  const { mutate: deleteAssignment } = useDelete();

  // Use realtime data when available, fallback to API data
  // Note: The realtime data focuses on queue assignments, but we need the detailed join data from the API
  const assignments = assignmentsResponse?.data ?? [];

  // Set up realtime message handling
  useEffect(() => {
    if (!isConnected) return;

    // Realtime updates are handled automatically by the hook
    // The controller will update the realtimeData when assignment changes are broadcast
    console.log("Help queue assignment management realtime connection established");
  }, [isConnected]);

  // Refresh assignments when realtime assignments change to get updated join data
  useEffect(() => {
    if (realtimeData.helpQueueAssignments.length > 0) {
      // Debounce refetch to avoid excessive API calls
      const timeoutId = setTimeout(() => {
        refetchAssignments();
      }, 500);

      return () => clearTimeout(timeoutId);
    }
  }, [realtimeData.helpQueueAssignments, refetchAssignments]);

  const handleEndAssignment = (assignmentId: number) => {
    updateAssignment({
      resource: "help_queue_assignments",
      id: assignmentId,
      values: {
        is_active: false,
        ended_at: new Date().toISOString()
      },
      successNotification: {
        message: "Assignment ended successfully",
        type: "success"
      },
      errorNotification: {
        message: "Failed to end assignment",
        type: "error"
      }
    });
  };

  const handleDeleteAssignment = (assignmentId: number) => {
    if (window.confirm("Are you sure you want to delete this assignment? This action cannot be undone.")) {
      deleteAssignment({
        resource: "help_queue_assignments",
        id: assignmentId,
        successNotification: {
          message: "Assignment deleted successfully",
          type: "success"
        },
        errorNotification: {
          message: "Failed to delete assignment",
          type: "error"
        }
      });
    }
  };

  if (assignmentsLoading || realtimeLoading) return <Text>Loading assignments...</Text>;
  if (assignmentsError) return <Alert status="error" title={`Error: ${assignmentsError.message}`} />;

  const activeAssignments = assignments.filter((a) => a.is_active);
  const inactiveAssignments = assignments.filter((a) => !a.is_active);

  const getQueueTypeColor = (type?: string) => {
    switch (type) {
      case "text":
        return "blue";
      case "video":
        return "green";
      case "in_person":
        return "orange";
      default:
        return "gray";
    }
  };

  const getQueueTypeLabel = (type?: string) => {
    switch (type) {
      case "text":
        return "Text Chat";
      case "video":
        return "Video Call";
      case "in_person":
        return "In Person";
      default:
        return type || "Unknown";
    }
  };

  const AssignmentCard = ({
    assignment,
    showActions = true
  }: {
    assignment: AssignmentWithDetails;
    showActions?: boolean;
  }) => (
    <Box p={4} borderWidth="1px" borderRadius="md">
      <Flex justify="space-between" align="flex-start">
        <Box flex="1">
          <Flex align="center" gap={3} mb={2}>
            <Text fontWeight="semibold">{assignment.help_queue?.name || `Queue #${assignment.help_queue_id}`}</Text>
            <Badge colorPalette={getQueueTypeColor(assignment.help_queue?.queue_type)} size="sm">
              {getQueueTypeLabel(assignment.help_queue?.queue_type)}
            </Badge>
            {assignment.is_active && (
              <Badge colorPalette="green" size="sm">
                Active
              </Badge>
            )}
            {isConnected && (
              <Text fontSize="xs" color="green.500">
                ● Live
              </Text>
            )}
          </Flex>

          <HStack spaceX={4} fontSize="sm" mb={2}>
            <HStack>
              <Icon as={BsPerson} />
              <Text>{assignment.profile?.name || "Unknown TA"}</Text>
            </HStack>
            <HStack>
              <Icon as={BsCalendar} />
              <Text>Started {formatDistanceToNow(new Date(assignment.started_at), { addSuffix: true })}</Text>
            </HStack>
            {assignment.ended_at && (
              <HStack>
                <Icon as={BsStopwatch} />
                <Text>Ended {formatDistanceToNow(new Date(assignment.ended_at), { addSuffix: true })}</Text>
              </HStack>
            )}
          </HStack>

          <HStack spaceX={4} fontSize="sm">
            <Text>
              <Text as="span" fontWeight="medium">
                Max Students:
              </Text>{" "}
              {assignment.max_concurrent_students}
            </Text>
            {assignment.ended_at && assignment.started_at && (
              <Text>
                <Text as="span" fontWeight="medium">
                  Duration:
                </Text>{" "}
                {Math.round(
                  (new Date(assignment.ended_at).getTime() - new Date(assignment.started_at).getTime()) / 60000
                )}{" "}
                minutes
              </Text>
            )}
          </HStack>
        </Box>

        {showActions && (
          <HStack spaceX={2}>
            {assignment.is_active && (
              <Button
                size="sm"
                variant="outline"
                colorPalette="orange"
                onClick={() => handleEndAssignment(assignment.id)}
              >
                End Assignment
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              colorPalette="red"
              onClick={() => handleDeleteAssignment(assignment.id)}
            >
              <Icon as={BsX} />
              Delete
            </Button>
          </HStack>
        )}
      </Flex>
    </Box>
  );

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Help Queue Assignment Management</Heading>
      </Flex>

      {/* Connection Status Indicator */}
      {!isConnected && (
        <Alert status="warning" title="Real-time updates disconnected" mb={4}>
          Assignment changes may not appear immediately. Connection status: {connectionStatus?.overall}
        </Alert>
      )}

      {/* Active Assignments */}
      <Box mb={8}>
        <Heading size="md" mb={4}>
          Active Assignments ({activeAssignments.length})
          {isConnected && (
            <Text as="span" fontSize="xs" color="green.500" ml={2}>
              ● Live updates
            </Text>
          )}
        </Heading>
        {activeAssignments.length === 0 ? (
          <Box textAlign="center" py={6} borderWidth="1px" borderRadius="md">
            <Text>No TAs are currently working on any queues.</Text>
          </Box>
        ) : (
          <Stack spaceY={3}>
            {activeAssignments.map((assignment) => (
              <AssignmentCard key={assignment.id} assignment={assignment} />
            ))}
          </Stack>
        )}
      </Box>

      {/* Assignment History */}
      <Box>
        <Heading size="md" mb={4}>
          Assignment History ({inactiveAssignments.length})
        </Heading>
        {inactiveAssignments.length === 0 ? (
          <Box textAlign="center" py={6} borderWidth="1px" borderRadius="md">
            <Text>No assignment history available.</Text>
          </Box>
        ) : (
          <Stack spaceY={3}>
            {inactiveAssignments.slice(0, 20).map((assignment) => (
              <AssignmentCard key={assignment.id} assignment={assignment} />
            ))}
            {inactiveAssignments.length > 20 && (
              <Text fontSize="sm" textAlign="center">
                Showing 20 most recent assignments. Total: {inactiveAssignments.length}
              </Text>
            )}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
