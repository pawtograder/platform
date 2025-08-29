"use client";

import { HStack, Icon, Text, Menu } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import { useCreate } from "@refinedev/core";
import { BsShield, BsExclamationTriangle, BsClock, BsBan, BsEye } from "react-icons/bs";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { toaster } from "@/components/ui/toaster";
import type { HelpRequestModeration } from "@/utils/supabase/DatabaseTypes";

type ModerationActionsProps = {
  helpRequestId: number;
  messageId?: number;
  studentProfileId: string;
  classId: number;
  onModerationComplete?: () => void;
};

/**
 * Component that provides quick moderation actions for help request messages.
 * Allows TAs and instructors to quickly moderate content and issue warnings/bans.
 * Uses RefineDiv only for creating moderation actions (mutations).
 */
export default function ModerationActions({
  helpRequestId,
  messageId,
  studentProfileId,
  classId,
  onModerationComplete
}: ModerationActionsProps) {
  const { private_profile_id } = useClassProfiles();
  const { mutateAsync: createModerationAction } = useCreate<HelpRequestModeration>();

  const handleModerationAction = async (
    actionType: "warning" | "temporary_ban" | "permanent_ban" | "message_deleted" | "message_edited",
    reason: string,
    durationMinutes?: number
  ) => {
    if (!private_profile_id) {
      toaster.error({
        title: "Error",
        description: "You must be logged in to perform moderation actions"
      });
      return;
    }

    try {
      // Calculate expires_at for temporary bans using UTC to avoid timezone issues
      let expires_at: string | null = null;
      if (actionType === "temporary_ban" && durationMinutes) {
        const expirationDate = new Date();
        expirationDate.setUTCMinutes(expirationDate.getUTCMinutes() + durationMinutes);
        expires_at = expirationDate.toISOString();
      }

      // For permanent bans, set a very large duration (100 years) while keeping expires_at null
      const finalDurationMinutes =
        actionType === "permanent_ban"
          ? 52560000 // 100 years in minutes
          : durationMinutes || null;

      await createModerationAction({
        resource: "help_request_moderation",
        values: {
          class_id: classId,
          help_request_id: helpRequestId,
          message_id: messageId || null,
          student_profile_id: studentProfileId,
          moderator_profile_id: private_profile_id,
          action_type: actionType,
          reason: messageId ? `${reason} (Message ID: ${messageId})` : reason,
          duration_minutes: finalDurationMinutes,
          is_permanent: actionType === "permanent_ban",
          expires_at
        },
        successNotification: {
          message: `${getActionLabel(actionType)} issued successfully`,
          type: "success"
        },
        errorNotification: {
          message: "Failed to issue moderation action",
          type: "error"
        }
      });

      onModerationComplete?.();
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to issue moderation action: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  const getActionLabel = (actionType: string) => {
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
        return "Action";
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

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button size="sm" colorPalette="red">
          <Icon as={BsShield} />
          Moderate
        </Button>
      </Menu.Trigger>
      <Menu.Positioner>
        <Menu.Content>
          <Menu.Item
            value="warning"
            onClick={() =>
              handleModerationAction(
                "warning",
                messageId ? "Inappropriate message content" : "General warning for behavior"
              )
            }
          >
            <HStack>
              <Icon as={getActionIcon("warning")} color="yellow.500" />
              <Text>Issue Warning</Text>
            </HStack>
          </Menu.Item>

          <Menu.Item
            value="temp-ban-1h"
            onClick={() =>
              handleModerationAction(
                "temporary_ban",
                messageId ? "Temporary ban due to inappropriate message" : "Temporary ban for disruptive behavior",
                60
              )
            }
          >
            <HStack>
              <Icon as={getActionIcon("temporary_ban")} color="orange.500" />
              <Text>1 Hour Ban</Text>
            </HStack>
          </Menu.Item>

          <Menu.Item
            value="temp-ban-24h"
            onClick={() =>
              handleModerationAction(
                "temporary_ban",
                messageId ? "24-hour ban due to inappropriate message" : "24-hour ban for serious misconduct",
                1440
              )
            }
          >
            <HStack>
              <Icon as={getActionIcon("temporary_ban")} color="orange.600" />
              <Text>24 Hour Ban</Text>
            </HStack>
          </Menu.Item>

          {messageId && (
            <>
              <Menu.Separator />
              <Menu.Item
                value="delete-message"
                onClick={() => handleModerationAction("message_deleted", "Message contained inappropriate content")}
              >
                <HStack>
                  <Icon as={getActionIcon("message_deleted")} color="purple.500" />
                  <Text>Delete Message</Text>
                </HStack>
              </Menu.Item>
            </>
          )}

          <Menu.Separator />
          <Menu.Item value="permanent-ban">
            <PopConfirm
              triggerLabel="Permanently ban student"
              trigger={
                <HStack width="100%" cursor="pointer">
                  <Icon as={getActionIcon("permanent_ban")} color="red.500" />
                  <Text color="red.500">Permanent Ban</Text>
                </HStack>
              }
              confirmHeader="Permanent Ban"
              confirmText="Are you sure you want to permanently ban this student? This action cannot be undone."
              onConfirm={async () => {
                handleModerationAction(
                  "permanent_ban",
                  "Permanent ban due to repeated violations or serious misconduct"
                );
              }}
            />
          </Menu.Item>
        </Menu.Content>
      </Menu.Positioner>
    </Menu.Root>
  );
}
