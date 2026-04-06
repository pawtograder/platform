"use client";

import { toaster } from "@/components/ui/toaster";
import type { HelpRequestMessageReadReceipt } from "@/utils/supabase/DatabaseTypes";
import { useCallback, useEffect, useMemo, useRef } from "react";
import useAuthState from "./useAuthState";
import { useClassProfiles } from "./useClassProfiles";
import { useOfficeHoursController } from "./useOfficeHoursRealtime";
import { useHelpRequestMessagesQuery } from "./office-hours-data/useHelpRequestMessagesQuery";
import { useHelpRequestReadReceiptsQuery } from "./office-hours-data/useHelpRequestReadReceiptsQuery";
import { useHelpRequestMessageInsert } from "./office-hours-data/useHelpRequestMessageMutations";
import { useHelpRequestReadReceiptInsert } from "./office-hours-data/useHelpRequestReadReceiptMutations";

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
 * Data reads (messages, read receipts) use TanStack Query via
 * `useHelpRequestMessagesQuery` / `useHelpRequestReadReceiptsQuery` which
 * have `gcTime: 5 * 60 * 1000` -- this replaces the old unbounded
 * `_helpRequestMessageControllers` Map on OfficeHoursController (P0 memory leak).
 *
 * Mutations use `useHelpRequestMessageInsert` / `useHelpRequestReadReceiptInsert`
 * which go through `useSupabaseRealtimeMutation` with optimistic updates.
 *
 * The OfficeHoursController is still used for:
 * - `markMessageAsRead()` dedup tracking (in-memory Set)
 * - Realtime channel management (ensureHelpRequestChannelReady, subscribeToHelpRequest)
 * - Connection status
 */
export function useRealtimeChat({
  helpRequestId,
  classId,
  enableChat = true
}: UseRealtimeChatOptions): UseRealtimeChatReturn {
  const controller = useOfficeHoursController();
  const { user } = useAuthState();
  const { private_profile_id } = useClassProfiles();

  // --- Data reads via TanStack Query (auto-eviction fixes the leak) ---
  const { data: messages = [], isLoading: messagesLoading } = useHelpRequestMessagesQuery(helpRequestId);
  const { data: allReadReceipts = [], isLoading: receiptsLoading } = useHelpRequestReadReceiptsQuery(helpRequestId);

  // --- Mutations via TanStack Query ---
  const insertMessage = useHelpRequestMessageInsert(helpRequestId);
  const insertReadReceipt = useHelpRequestReadReceiptInsert(helpRequestId);

  // Filter read receipts for this help request and exclude current user
  const readReceipts = useMemo(() => {
    const messageIds = messages.filter((msg) => msg.help_request_id === helpRequestId).map((msg) => msg.id);

    return allReadReceipts.filter(
      (receipt) => messageIds.includes(receipt.message_id) && receipt.viewer_id !== private_profile_id
    );
  }, [allReadReceipts, messages, helpRequestId, private_profile_id]);

  // Track if the effect has been cleaned up to avoid state updates after unmount
  const cleanedUpRef = useRef(false);

  useEffect(() => {
    cleanedUpRef.current = false;
    let unsubscribe: (() => void) | null = null;

    // Async initialization to properly await channel subscription
    const initializeChat = async () => {
      try {
        // Step 1: Ensure the channel is ready BEFORE subscribing
        // This prevents the race condition where messages are missed between
        // the refetch completing and the channel being fully subscribed
        await controller.officeHoursRealTimeController.ensureHelpRequestChannelReady(helpRequestId);

        if (cleanedUpRef.current) return;

        // Step 2: Now subscribe to the channel (channel is already created)
        unsubscribe = controller.officeHoursRealTimeController.subscribeToHelpRequest(helpRequestId, () => {});
      } catch (error) {
        // Log but don't throw - chat should degrade gracefully
        console.error("Error initializing chat subscription:", error);
      }
    };

    initializeChat();

    return () => {
      cleanedUpRef.current = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [helpRequestId, classId, controller]);

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
        await insertMessage.mutateAsync({
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
    [enableChat, user, private_profile_id, helpRequestId, classId, insertMessage]
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
        await insertReadReceipt.mutateAsync({
          message_id: messageId,
          viewer_id: private_profile_id,
          class_id: classId,
          help_request_id: helpRequestId
        } as unknown as Parameters<typeof insertReadReceipt.mutateAsync>[0]);
      } catch (error) {
        // Remove from marked set on failure to allow retry
        controller.clearMarkedAsReadState();
        controller.markMessageAsRead(messageId); // Re-mark since we cleared all
        throw error;
      }
    },
    [enableChat, user, private_profile_id, classId, allReadReceipts, controller, helpRequestId, insertReadReceipt]
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
    isLoading: messagesLoading || receiptsLoading
  };
}
