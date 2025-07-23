"use client";

import { Box, Flex, HStack, Stack, Text, Heading, Icon, Badge, VStack, IconButton } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useList, useDelete } from "@refinedev/core";
import { useParams } from "next/navigation";
import { BsShield, BsExclamationTriangle, BsClock, BsBan, BsEye, BsPlus, BsTrash } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";
import { Alert } from "@/components/ui/alert";
import useModalManager from "@/hooks/useModalManager";
import CreateModerationActionModal from "./modals/createModerationActionModal";
import { useOfficeHoursRealtime } from "@/hooks/useOfficeHoursRealtime";
import { useEffect, useState } from "react";
import { toaster } from "@/components/ui/toaster";
import { useIsInstructor } from "@/hooks/useClassProfiles";
import type {
  HelpRequestModeration,
  UserProfile,
  HelpRequest,
  HelpRequestMessage
} from "@/utils/supabase/DatabaseTypes";

type ModerationActionWithDetails = HelpRequestModeration & {
  student_profile?: UserProfile;
  moderator_profile?: UserProfile;
  help_request?: HelpRequest;
  help_request_message?: HelpRequestMessage;
};

/**
 * Component for managing moderation actions and student bans.
 * Allows instructors and TAs to view moderation history and create new moderation actions.
 * Uses real-time updates to show moderation changes immediately across all staff.
 */
export default function ModerationManagement() {
  const { course_id } = useParams();
  const [filterStatus, setFilterStatus] = useState<"all" | "active" | "expired">("all");
  const isInstructor = useIsInstructor();

  // Modal management
  const createModal = useModalManager();

  // Set up real-time subscriptions for staff data including moderation
  const {
    data: realtimeData,
    isConnected,
    connectionStatus,
    isLoading: realtimeLoading
  } = useOfficeHoursRealtime({
    classId: Number(course_id),
    enableGlobalQueues: false, // Not needed for moderation
    enableStaffData: true // Enable staff data subscriptions
  });

  // Fetch all moderation actions for the course with related data
  const {
    data: moderationResponse,
    isLoading: moderationLoading,
    error: moderationError,
    refetch: refetchModeration
  } = useList<ModerationActionWithDetails>({
    resource: "help_request_moderation",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    sorters: [{ field: "created_at", order: "desc" }],
    meta: {
      select: `
        *,
        student_profile:student_profile_id(*),
        moderator_profile:moderator_profile_id(*),
        help_request:help_request_id(*),
        help_request_message:message_id(*)
      `
    }
  });

  // Delete functionality
  const { mutate: deleteModerationAction, isPending: isDeleting } = useDelete();

  // Use realtime data when available, fallback to API data
  // Note: The realtime moderation data comes from helpRequestModeration array
  const moderationActions = moderationResponse?.data ?? [];

  // Set up realtime message handling
  useEffect(() => {
    if (!isConnected) return;

    // Realtime updates are handled automatically by the hook
    // The controller will update the realtimeData when moderation changes are broadcast
    console.log("Moderation management realtime connection established");
  }, [isConnected]);

  // Refresh moderation data when realtime moderation changes to get updated join data
  useEffect(() => {
    if (realtimeData.helpRequestModeration.length > 0) {
      refetchModeration();
    }
  }, [realtimeData.helpRequestModeration, refetchModeration]);

  const handleCreateSuccess = () => {
    createModal.closeModal();
    refetchModeration();
  };

  const handleDeleteModerationAction = (actionId: number) => {
    if (window.confirm("Are you sure you want to delete this moderation action? This action cannot be undone.")) {
      deleteModerationAction(
        {
          resource: "help_request_moderation",
          id: actionId
        },
        {
          onSuccess: () => {
            refetchModeration();
          },
          onError: (error) => {
            toaster.error({
              title: "Failed to delete moderation action",
              description: error instanceof Error ? error.message : "An unexpected error occurred"
            });
          }
        }
      );
    }
  };

  if (moderationLoading || realtimeLoading) return <Text>Loading moderation actions...</Text>;
  if (moderationError) return <Alert status="error" title={`Error: ${moderationError.message}`} />;

  // ---------------------------------------------------------------------------
  // Helper Functions
  // ---------------------------------------------------------------------------

  /**
   * Determines if a moderation action is currently active.
   * A permanent action is always active. For temporary actions, the action is
   * active if the `expires_at` timestamp is in the future relative to now.
   */
  function isActionActive(action: ModerationActionWithDetails): boolean {
    if (action.is_permanent) return true;
    if (!action.expires_at) return false;
    return new Date(action.expires_at) > new Date();
  }

  // Filter moderation actions based on status. This must be declared *after*
  // the `isActionActive` helper so that it can be referenced safely at runtime.
  const filteredActions = moderationActions.filter((action) => {
    if (filterStatus === "all") return true;

    if (filterStatus === "active") {
      return isActionActive(action);
    }
    if (filterStatus === "expired") {
      return !action.is_permanent && !isActionActive(action);
    }
    return true;
  });

  const getActionTypeColor = (actionType: string) => {
    switch (actionType) {
      case "warning":
        return "yellow";
      case "temporary_ban":
        return "orange";
      case "permanent_ban":
        return "red";
      case "message_deleted":
        return "purple";
      case "message_edited":
        return "blue";
      default:
        return "gray";
    }
  };

  const getActionTypeLabel = (actionType: string) => {
    switch (actionType) {
      case "warning":
        return "Warning";
      case "temporary_ban":
        return "Temporary Ban";
      case "permanent_ban":
        return "Permanent Ban";
      case "message_deleted":
        return "Message Deleted";
      case "message_edited":
        return "Message Edited";
      default:
        return actionType;
    }
  };

  const getActionIcon = (actionType: string) => {
    switch (actionType) {
      case "warning":
        return BsExclamationTriangle;
      case "temporary_ban":
        return BsClock;
      case "permanent_ban":
        return BsBan;
      case "message_deleted":
      case "message_edited":
        return BsEye;
      default:
        return BsShield;
    }
  };

  const ModerationActionCard = ({ action }: { action: ModerationActionWithDetails }) => (
    <Box p={4} borderWidth="1px" borderRadius="md">
      <Flex justify="space-between" align="flex-start">
        <Box flex="1">
          <Flex align="center" gap={3} mb={2}>
            <Icon as={getActionIcon(action.action_type)} />
            <Text fontWeight="semibold">{getActionTypeLabel(action.action_type)}</Text>
            <Badge colorPalette={getActionTypeColor(action.action_type)} size="sm">
              {action.is_permanent ? "Permanent" : isActionActive(action) ? "Active" : "Expired"}
            </Badge>
            {isConnected && (
              <Text fontSize="xs" color="green.500">
                ● Live
              </Text>
            )}
          </Flex>

          <VStack align="start" gap={2} mb={3}>
            <HStack>
              <Text fontSize="sm" fontWeight="medium">
                Student:
              </Text>
              <Text fontSize="sm">{action.student_profile?.name || "Unknown Student"}</Text>
            </HStack>
            <HStack>
              <Text fontSize="sm" fontWeight="medium">
                Moderator:
              </Text>
              <Text fontSize="sm">{action.moderator_profile?.name || "Unknown Moderator"}</Text>
            </HStack>
            {action.reason && (
              <HStack>
                <Text fontSize="sm" fontWeight="medium">
                  Reason:
                </Text>
                <Text fontSize="sm">{action.reason}</Text>
              </HStack>
            )}
          </VStack>

          <HStack spaceX={4} fontSize="sm" mb={2}>
            <Text>Created {formatDistanceToNow(new Date(action.created_at), { addSuffix: true })}</Text>
            {action.duration_minutes && <Text>Duration: {action.duration_minutes} minutes</Text>}
            {action.expires_at && (
              <Text>Expires {formatDistanceToNow(new Date(action.expires_at), { addSuffix: true })}</Text>
            )}
          </HStack>

          {action.help_request && <Text fontSize="sm">Help Request #{action.help_request.id}</Text>}
        </Box>

        {/* Delete Button */}
        {isInstructor && (
          <IconButton
            aria-label="Delete moderation action"
            colorPalette="red"
            variant="ghost"
            size="sm"
            loading={isDeleting}
            onClick={() => handleDeleteModerationAction(action.id)}
          >
            <Icon as={BsTrash} />
          </IconButton>
        )}
      </Flex>
    </Box>
  );

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Moderation Management</Heading>
        <Button onClick={() => createModal.openModal()}>
          <Icon as={BsPlus} />
          Create Moderation Action
        </Button>
      </Flex>

      {/* Connection Status Indicator */}
      {!isConnected && (
        <Alert status="warning" title="Real-time updates disconnected" mb={4}>
          Moderation changes may not appear immediately. Connection status: {connectionStatus?.overall}
        </Alert>
      )}

      {/* Filter Controls */}
      <HStack mb={6} gap={3}>
        <Text fontSize="sm" fontWeight="medium">
          Filter:
        </Text>
        <Button size="sm" variant={filterStatus === "all" ? "solid" : "outline"} onClick={() => setFilterStatus("all")}>
          All ({moderationActions.length})
        </Button>
        <Button
          size="sm"
          variant={filterStatus === "active" ? "solid" : "outline"}
          onClick={() => setFilterStatus("active")}
        >
          Active ({moderationActions.filter((a) => a.is_permanent || isActionActive(a)).length})
        </Button>
        <Button
          size="sm"
          variant={filterStatus === "expired" ? "solid" : "outline"}
          onClick={() => setFilterStatus("expired")}
        >
          Expired ({moderationActions.filter((a) => !a.is_permanent && !isActionActive(a)).length})
        </Button>
        {isConnected && (
          <Text fontSize="xs" color="green.500">
            ● Live updates
          </Text>
        )}
      </HStack>

      {/* Moderation Actions List */}
      {filteredActions.length === 0 ? (
        <Box textAlign="center" py={8}>
          <Icon as={BsShield} boxSize={12} mb={4} />
          <Text mb={4}>
            {filterStatus === "all"
              ? "No moderation actions have been taken yet."
              : `No ${filterStatus} moderation actions found.`}
          </Text>
          {filterStatus === "all" && (
            <Button onClick={() => createModal.openModal()}>
              <Icon as={BsPlus} />
              Create First Moderation Action
            </Button>
          )}
        </Box>
      ) : (
        <Stack spaceY={3}>
          {filteredActions.map((action) => (
            <ModerationActionCard key={action.id} action={action} />
          ))}
        </Stack>
      )}

      {/* Create Moderation Action Modal */}
      <CreateModerationActionModal
        isOpen={createModal.isOpen}
        onClose={createModal.closeModal}
        onSuccess={handleCreateSuccess}
      />
    </Box>
  );
}
