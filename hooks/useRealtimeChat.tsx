"use client";

import { toaster } from "@/components/ui/toaster";
import type { HelpRequestMessageReadReceipt } from "@/utils/supabase/DatabaseTypes";
import { useCallback, useEffect, useMemo } from "react";
import useAuthState from "./useAuthState";
import { useClassProfiles } from "./useClassProfiles";
import { useHelpRequestMessages, useHelpRequestReadReceipts, useOfficeHoursController } from "./useOfficeHoursRealtime";
import { help } from "mathjs";

export interface UseRealtimeChatOptions {
  helpRequestId: number;
  classId: number;
  enableChat?: boolean;
}

export interface UseRealtimeChatReturn {
  // Chat functionality
  sendMessage: (content: string, replyToMessageId?: number | null) => Promise<void>;
  markMessageAsRead: (messageId: number, messageAuthorId?: string) => Promise<void>;

  // Connection status
  isConnected: boolean;
  isValidating: boolean;
  isAuthorized: boolean;
  connectionError: string | null;

  // Read receipts (excluding current user)
  readReceipts: HelpRequestMessageReadReceipt[];

  // Loading state
  isLoading: boolean;
}

/**
 * Hook for real-time chat functionality in help requests.
 * Provides message sending, read receipt management, and connection status.
 *
 * This hook replaces the chat-specific functionality from useOfficeHoursRealtime.
 */
export function useRealtimeChat({
  helpRequestId,
  classId,
  enableChat = true
}: UseRealtimeChatOptions): UseRealtimeChatReturn {
  const controller = useOfficeHoursController();
  const { user } = useAuthState();
  const { private_profile_id } = useClassProfiles();

  // Get messages and read receipts using individual hooks
  const messages = useHelpRequestMessages(helpRequestId);
  const allReadReceipts = useHelpRequestReadReceipts();

  // Filter read receipts for this help request and exclude current user
  const readReceipts = useMemo(() => {
    const messageIds = messages.filter((msg) => msg.help_request_id === helpRequestId).map((msg) => msg.id);

    return allReadReceipts.filter(
      (receipt) => messageIds.includes(receipt.message_id) && receipt.viewer_id !== private_profile_id
    );
  }, [allReadReceipts, messages, helpRequestId, private_profile_id]);

  useEffect(() => {
    const unsubscribe = controller.officeHoursRealTimeController.subscribeToHelpRequest(helpRequestId, () => {}); //Table controller will receive updates
    return () => {
      unsubscribe();
    };
  }, [helpRequestId, classId, controller]);

  const { helpRequestMessages, helpRequestReadReceipts } = controller;

  // Get connection status from controller
  const connectionStatus = controller.getConnectionStatus();
  const isConnected = connectionStatus.overall === "connected";
  const isValidating = connectionStatus.overall === "connecting";
  const isAuthorized = connectionStatus.overall !== "disconnected";
  const connectionError = null; // TODO: Extract from controller if available

  const sendMessage = useCallback(
    async (content: string, replyToMessageId?: number | null) => {
      if (!enableChat) {
        throw new Error("Chat functionality not enabled");
      }

      if (!user || !private_profile_id) {
        throw new Error("User authentication required");
      }

      if (!content.trim()) {
        throw new Error("Message content cannot be empty");
      }

      try {
        await helpRequestMessages.create({
          message: content,
          help_request_id: helpRequestId,
          author: private_profile_id,
          class_id: classId,
          instructors_only: false,
          reply_to_message_id: replyToMessageId || null
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        toaster.error({
          title: "Failed to send message",
          description: `Failed to send message: ${errorMessage}`
        });
        throw error;
      }
    },
    [enableChat, user, private_profile_id, helpRequestId, classId, helpRequestMessages]
  );

  const markMessageAsRead = useCallback(
    async (messageId: number, messageAuthorId?: string) => {
      if (!enableChat || !user || !private_profile_id) {
        return;
      }

      // Skip if current user is message author
      if (messageAuthorId && (messageAuthorId === user.id || messageAuthorId === private_profile_id)) {
        return;
      }

      // Use controller's persistent tracking to prevent duplicate API calls
      if (!controller.markMessageAsRead(messageId)) {
        return;
      }

      // Check if read receipt already exists in current data
      const existingReceipt = allReadReceipts.find(
        (receipt) => receipt.message_id === messageId && receipt.viewer_id === private_profile_id
      );

      if (existingReceipt) {
        return;
      }

      try {
        await helpRequestReadReceipts.create({
          message_id: messageId,
          viewer_id: private_profile_id,
          class_id: classId,
          help_request_id: helpRequestId
        } as unknown as HelpRequestMessageReadReceipt);
      } catch (error) {
        // Remove from marked set on failure to allow retry
        controller.clearMarkedAsReadState();
        controller.markMessageAsRead(messageId); // Re-mark since we cleared all
        throw error;
      }
    },
    [enableChat, user, private_profile_id, classId, allReadReceipts, helpRequestReadReceipts, controller]
  );

  return {
    sendMessage: enableChat
      ? sendMessage
      : async () => {
          throw new Error("Chat not enabled");
        },
    markMessageAsRead: enableChat ? markMessageAsRead : async () => {},
    isConnected,
    isValidating,
    isAuthorized,
    connectionError,
    readReceipts,
    isLoading: !controller.isReady
  };
}
