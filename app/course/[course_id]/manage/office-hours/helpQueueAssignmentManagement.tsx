"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import { useAllProfilesForClass } from "@/hooks/useCourseController";
import { useConnectionStatus, useHelpQueueAssignments, useHelpQueues } from "@/hooks/useOfficeHoursRealtime";
import type { HelpQueue, HelpQueueAssignment, UserProfile } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Flex, Heading, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { useDelete, useUpdate } from "@refinedev/core";
import { formatDistanceToNow } from "date-fns";
import { useMemo } from "react";
import { BsCalendar, BsPerson, BsStopwatch, BsTrash } from "react-icons/bs";

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
  // Use individual hooks for better performance and maintainability
  const helpQueues = useHelpQueues();
  const helpQueueAssignments = useHelpQueueAssignments();
  const { isConnected, connectionStatus } = useConnectionStatus();

  // Loading state when any data is still loading
  const realtimeLoading = !helpQueues || !helpQueueAssignments;

  // Get class profiles
  const profiles = useAllProfilesForClass();

  // Mutations for assignment management - only use Refine for database operations
  const { mutateAsync: updateAssignment } = useUpdate();
  const { mutateAsync: deleteAssignment } = useDelete();

  // Combine assignment and queue data with profile data
  const assignments = useMemo((): AssignmentWithDetails[] => {
    if (!helpQueueAssignments || !helpQueues) return [];

    return helpQueueAssignments.map((assignment) => ({
      ...assignment,
      help_queue: helpQueues.find((queue) => queue.id === assignment.help_queue_id),
      profile: profiles.find((profile) => profile.id === assignment.ta_profile_id)
    }));
  }, [helpQueueAssignments, helpQueues, profiles]);

  // Sort assignments by active status and start time
  const sortedAssignments = useMemo(() => {
    return [...assignments].sort((a, b) => {
      // Active assignments first
      if (a.is_active && !b.is_active) return -1;
      if (!a.is_active && b.is_active) return 1;

      // Then by start time (most recent first)
      return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
    });
  }, [assignments]);

  // Loading state - wait for realtime data
  const isLoading = realtimeLoading;

  const handleEndAssignment = async (assignmentId: number) => {
    await updateAssignment({
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

  const handleDeleteAssignment = async (assignmentId: number) => {
    await deleteAssignment({
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
  };

  if (isLoading) return <Text>Loading assignments...</Text>;

  const activeAssignments = sortedAssignments.filter((a) => a.is_active);
  const inactiveAssignments = sortedAssignments.filter((a) => !a.is_active);

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
              <Button size="sm" colorPalette="yellow" onClick={async () => await handleEndAssignment(assignment.id)}>
                End Assignment
              </Button>
            )}
            <PopConfirm
              triggerLabel="Delete assignment"
              trigger={
                <Button size="sm" colorPalette="red">
                  <Icon as={BsTrash} />
                  Delete
                </Button>
              }
              confirmHeader="Delete Assignment"
              confirmText="Are you sure you want to delete this assignment? This action cannot be undone."
              onConfirm={async () => await handleDeleteAssignment(assignment.id)}
            />
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
