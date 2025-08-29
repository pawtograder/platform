"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { useIsInstructor } from "@/hooks/useClassProfiles";
import { useAllProfilesForClass } from "@/hooks/useCourseController";
import useModalManager from "@/hooks/useModalManager";
import { useHelpRequestModeration, useHelpRequests, useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import type {
  HelpRequest,
  HelpRequestMessage,
  HelpRequestModeration,
  UserProfile
} from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Flex, Heading, HStack, Icon, IconButton, Stack, Text, VStack } from "@chakra-ui/react";
import { useDelete } from "@refinedev/core";
import { formatDistanceToNow } from "date-fns";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { BsBan, BsClock, BsExclamationTriangle, BsEye, BsPlus, BsShield, BsTrash } from "react-icons/bs";
import CreateModerationActionModal from "./modals/createModerationActionModal";

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
  const profiles = useAllProfilesForClass();

  // Modal management
  const createModal = useModalManager();

  // Get realtime data using individual hooks
  const moderationData = useHelpRequestModeration();
  const helpRequestsData = useHelpRequests();
  const controller = useOfficeHoursController();

  const { mutateAsync: deleteModerationAction, isPending: isDeleting } = useDelete();

  // Create a map of profiles for efficient lookup
  const profilesMap = useMemo(() => {
    const map = new Map<string, UserProfile>();
    profiles.forEach((profile) => {
      map.set(profile.id, profile);
    });
    return map;
  }, [profiles]);

  // Filter help requests for this class
  const classHelpRequests = useMemo(() => {
    return helpRequestsData.filter((request) => request.class_id === Number(course_id));
  }, [helpRequestsData, course_id]);

  // Join moderation data with profile data in memory
  const moderationActions = useMemo((): ModerationActionWithDetails[] => {
    return moderationData
      .filter((action) => action.class_id === Number(course_id))
      .map((action) => ({
        ...action,
        student_profile: action.student_profile_id ? profilesMap.get(action.student_profile_id) : undefined,
        moderator_profile: action.moderator_profile_id ? profilesMap.get(action.moderator_profile_id) : undefined,
        help_request: action.help_request_id
          ? classHelpRequests.find((req) => req.id === action.help_request_id)
          : undefined
      }));
  }, [moderationData, classHelpRequests, profilesMap, course_id]);

  const handleCreateSuccess = () => {
    createModal.closeModal();
    // No need to refetch - realtime updates will handle this automatically
  };

  const handleDeleteModerationAction = async (actionId: number) => {
    await deleteModerationAction(
      {
        resource: "help_request_moderation",
        id: actionId
      },
      {
        onSuccess: () => {
          // Realtime updates will handle the UI update automatically
          toaster.success({
            title: "Moderation action deleted successfully"
          });
        },
        onError: (error) => {
          toaster.error({
            title: "Failed to delete moderation action",
            description: error instanceof Error ? error.message : "An unexpected error occurred"
          });
        }
      }
    );
  };

  // Get connection status from controller
  const connectionStatus = controller.getConnectionStatus();
  const isConnected = connectionStatus.overall === "connected";

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
            <Badge colorPalette={getActionTypeColor(action.action_type)} variant="solid" size="sm">
              {action.is_permanent ? "Permanent" : isActionActive(action) ? "Active" : "Expired"}
            </Badge>
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
          <PopConfirm
            triggerLabel="Delete moderation action"
            trigger={
              <IconButton aria-label="Delete moderation action" colorPalette="red" size="sm" loading={isDeleting}>
                <Icon as={BsTrash} />
              </IconButton>
            }
            confirmHeader="Delete Moderation Action"
            confirmText="Are you sure you want to delete this moderation action? This action cannot be undone."
            onConfirm={async () => await handleDeleteModerationAction(action.id)}
          />
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
          Moderation changes may not appear immediately. Connection status: {connectionStatus.overall}
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
