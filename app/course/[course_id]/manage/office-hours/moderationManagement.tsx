"use client";

import { Box, Flex, HStack, Stack, Text, Heading, Icon, Badge, VStack } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { BsShield, BsExclamationTriangle, BsClock, BsBan, BsEye, BsPlus } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";
import { Alert } from "@/components/ui/alert";
import useModalManager from "@/hooks/useModalManager";
import CreateModerationActionModal from "./modals/createModerationActionModal";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { useState } from "react";

type ModerationAction = Database["public"]["Tables"]["help_request_moderation"]["Row"];
type Profile = Database["public"]["Tables"]["profiles"]["Row"];
type HelpRequest = Database["public"]["Tables"]["help_requests"]["Row"];
type HelpRequestMessage = Database["public"]["Tables"]["help_request_messages"]["Row"];

type ModerationActionWithDetails = ModerationAction & {
  student_profile?: Profile;
  moderator_profile?: Profile;
  help_request?: HelpRequest;
  help_request_message?: HelpRequestMessage;
};

/**
 * Component for managing moderation actions and student bans.
 * Allows instructors and TAs to view moderation history and create new moderation actions.
 */
export default function ModerationManagement() {
  const { course_id } = useParams();
  const [filterStatus, setFilterStatus] = useState<"all" | "active" | "expired">("all");

  // Modal management
  const createModal = useModalManager();

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

  const handleCreateSuccess = () => {
    createModal.closeModal();
    refetchModeration();
  };

  if (moderationLoading) return <Text>Loading moderation actions...</Text>;
  if (moderationError) return <Alert status="error" title={`Error: ${moderationError.message}`} />;

  const moderationActions = moderationResponse?.data ?? [];

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
