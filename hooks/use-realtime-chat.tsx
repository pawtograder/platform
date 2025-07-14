"use client";

import { createClient } from "@/utils/supabase/client";
import { useCallback, useEffect, useState, useOptimistic, useMemo } from "react";
import { useCreate, useList } from "@refinedev/core";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import type {
  HelpRequest,
  HelpRequestMessageWithoutId,
  HelpRequestMessageReadReceipt
} from "@/utils/supabase/DatabaseTypes";

interface UseRealtimeChatProps {
  username: string; // Display name for UI - restored from old version
  helpRequest: HelpRequest;
  messages?: ChatMessage[]; // Messages from parent component
}

export type ChatMessage = HelpRequestMessageWithoutId & {
  id: number | null;
  read_receipts?: HelpRequestMessageReadReceipt[];
};

// Broadcast message type for real-time communication
export interface BroadcastMessage {
  id: string;
  content: string;
  user: {
    id: string;
    name: string;
  };
  createdAt: string;
  replyToMessageId?: number | null;
  helpRequestId: number;
  classId: number;
}

// Broadcast read receipt type for real-time communication
export interface BroadcastReadReceipt {
  id: string;
  messageId: number;
  userId: string; // Auth user ID
  userName: string; // Display name
  classId: number;
  createdAt: string;
}

const EVENT_MESSAGE_TYPE = "message";
const EVENT_READ_RECEIPT_TYPE = "read_receipt";

export function useRealtimeChat({ helpRequest, messages = [] }: UseRealtimeChatProps) {
  const supabase = createClient();
  const [broadcastMessages, setBroadcastMessages] = useState<BroadcastMessage[]>([]);
  const [broadcastReadReceipts, setBroadcastReadReceipts] = useState<BroadcastReadReceipt[]>([]);
  const [channel, setChannel] = useState<ReturnType<typeof supabase.channel> | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [participants, setParticipants] = useState<string[]>([]);

  // Track pending read receipt creations to prevent duplicates
  const [pendingReadReceipts, setPendingReadReceipts] = useState<Set<string>>(new Set());

  // Get the actual authenticated user ID (UUID) for presence/display
  const { user } = useAuthState();
  const userId = user?.id; // This is the UUID we need for presence

  // Get the profile ID for database operations (this is what RLS policies expect)
  const { private_profile_id } = useClassProfiles();

  // Add Refine's useCreate hook for database persistence
  const { mutateAsync: createMessage } = useCreate({
    resource: "help_request_messages"
  });

  // Add useCreate for read receipts
  const { mutateAsync: createReadReceipt } = useCreate({
    resource: "help_request_message_read_receipts"
  });

  // Get message IDs from the passed messages for initial read receipt fetching
  const messageIds = useMemo(() => {
    return messages.map((msg) => msg.id).filter((id): id is number => id !== null);
  }, [messages]);

  // Fetch initial read receipts from database (without live mode to avoid conflicts)
  // This gives us the baseline state, then broadcasts handle real-time updates
  const { data: initialReadReceipts, refetch: refetchReadReceipts } = useList<HelpRequestMessageReadReceipt>({
    resource: "help_request_message_read_receipts",
    filters:
      messageIds.length > 0
        ? [{ field: "message_id", operator: "in", value: messageIds }]
        : [
            { field: "message_id", operator: "eq", value: -1 } // No results if no messages yet
          ],
    pagination: { pageSize: 1000 },
    // Remove liveMode to avoid conflicts with broadcast system
    queryOptions: {
      enabled: messageIds.length > 0 // Only fetch when we have message IDs
    }
  });

  // Merge database read receipts with broadcast read receipts for real-time updates
  const allReadReceipts = useMemo(() => {
    const mergedReceipts: HelpRequestMessageReadReceipt[] = [...(initialReadReceipts?.data || [])];

    // Add broadcast receipts that aren't already in database
    broadcastReadReceipts.forEach((broadcastReceipt) => {
      // Note: Database uses profile IDs, broadcast uses auth user IDs
      // For the current user, check if we already have a receipt for this message
      // We can't easily convert between user ID and profile ID here, so we'll check by message and timing
      const isDuplicate = (initialReadReceipts?.data || []).some(
        (dbReceipt) =>
          dbReceipt.message_id === broadcastReceipt.messageId &&
          // For current user's receipts, we can compare with private_profile_id
          ((broadcastReceipt.userId === userId && dbReceipt.viewer_id === private_profile_id) ||
            // For other users, just check by timing since we can't convert user ID to profile ID
            (broadcastReceipt.userId !== userId &&
              Math.abs(new Date(dbReceipt.created_at).getTime() - new Date(broadcastReceipt.createdAt).getTime()) <
                5000))
      );

      if (!isDuplicate) {
        // Convert broadcast receipt to database format
        const dbFormatReceipt: HelpRequestMessageReadReceipt = {
          id: Date.now() + Math.random(), // Temporary ID for broadcast receipts
          message_id: broadcastReceipt.messageId,
          viewer_id: broadcastReceipt.userId === userId ? private_profile_id : broadcastReceipt.userId, // Use profile ID for current user
          class_id: broadcastReceipt.classId,
          created_at: broadcastReceipt.createdAt
        };
        mergedReceipts.push(dbFormatReceipt);
      }
    });

    return mergedReceipts;
  }, [initialReadReceipts?.data, broadcastReadReceipts, userId, private_profile_id]);

  // Optimistic read receipts for immediate UI feedback - restored from old version
  const [optimisticReadReceipts, addOptimisticReadReceipt] = useOptimistic(
    allReadReceipts,
    (state, newReceipt: HelpRequestMessageReadReceipt) => [...state, newReceipt]
  );

  useEffect(() => {
    // Use the exact channel name format that the database trigger expects
    // The trigger uses 'help_request_' || help_request_id::text
    const channelName = `help_request_${helpRequest.id}`;

    const newChannel = supabase.channel(channelName, {
      config: {
        broadcast: { self: true }
      }
    });

    newChannel
      .on("broadcast", { event: EVENT_MESSAGE_TYPE }, (payload) => {
        const message = payload.payload as BroadcastMessage;
        // Add all broadcast messages since triggers handle the broadcasting
        setBroadcastMessages((current) => [...current, message]);
      })
      .on("broadcast", { event: EVENT_READ_RECEIPT_TYPE }, (payload) => {
        const receipt = payload.payload as BroadcastReadReceipt;
        // Add the receipt - deduplication handled in merge logic
        setBroadcastReadReceipts((current) => [...current, receipt]);
      })
      .on("presence", { event: "sync" }, () => {
        // Track presence for participants
        const getUidsFromPresence = (presence: Record<string, { user_id: string }[]>) => {
          const uids = new Set<string>();
          Object.keys(presence).forEach((key) => {
            if (presence[key][0]) {
              uids.add(presence[key][0].user_id);
            }
          });
          return Array.from(uids);
        };
        setParticipants(getUidsFromPresence(newChannel.presenceState()));
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          setIsConnected(true);
          // Track user presence using actual user ID
          if (userId) {
            newChannel.track({ user_id: userId });
          }
        }
      });

    setChannel(newChannel);

    // Cleanup on component unmount or when dependencies change
    return () => {
      newChannel.unsubscribe();
      setIsConnected(false);
      setBroadcastMessages([]);
      setBroadcastReadReceipts([]);
      setParticipants([]);
    };
  }, [helpRequest.id, userId, supabase]); // Use helpRequest.id instead of roomName for consistency

  // Refetch initial read receipts when messages change
  useEffect(() => {
    if (messageIds.length > 0) {
      refetchReadReceipts();
    }
  }, [messageIds, refetchReadReceipts]);

  const sendMessage = useCallback(
    async (content: string, replyToMessageId?: number | null) => {
      if (!channel || !isConnected || !userId || !private_profile_id) {
        console.error("Cannot send message: missing required authentication", {
          channel: !!channel,
          isConnected,
          userId,
          private_profile_id
        });
        return;
      }

      try {
        // Persist message to database - the trigger will handle broadcasting automatically
        await createMessage({
          values: {
            message: content,
            help_request_id: helpRequest.id,
            author: private_profile_id, // This must be a profile ID matching the database schema
            class_id: helpRequest.class_id,
            instructors_only: false,
            reply_to_message_id: replyToMessageId || null
          }
        });
      } catch (error) {
        console.error("❌ Failed to send message:", error);
        throw error; // Re-throw so UI can handle the error
      }
    },
    [channel, isConnected, userId, helpRequest, createMessage, private_profile_id]
  );

  const markMessageAsRead = useCallback(
    async (messageId: number, messageAuthorId?: string) => {
      if (!messageId || !userId || !channel || !isConnected) {
        console.error("Cannot mark message as read: missing required authentication", {
          messageId,
          userId,
          channel: !!channel,
          isConnected
        });
        return;
      }

      // Skip creating read receipts if the current user is the message author
      // messageAuthorId could be either a profile ID (database messages) or auth user ID (broadcast messages)
      if (messageAuthorId && (messageAuthorId === userId || messageAuthorId === private_profile_id)) {
        return;
      }

      // Create a unique key for this read receipt to prevent duplicates
      const receiptKey = `${messageId}-${private_profile_id}`;

      // Check if we're already processing this read receipt
      if (pendingReadReceipts.has(receiptKey)) {
        return;
      }

      try {
        // Mark this receipt as pending to prevent duplicates
        setPendingReadReceipts((prev) => new Set(prev).add(receiptKey));

        // Check if read receipt already exists using actual database data (not optimistic)
        // Note: viewer_id in database schema now references profile IDs
        const existingReceipt = (initialReadReceipts?.data || []).find(
          (receipt) => receipt.message_id === messageId && receipt.viewer_id === private_profile_id
        );

        if (existingReceipt) {
          return;
        }

        // Double-check database directly before creating to prevent duplicates
        const { data: existingReceiptCheck, error: checkError } = await supabase
          .from("help_request_message_read_receipts")
          .select("id")
          .eq("message_id", messageId)
          .eq("viewer_id", private_profile_id)
          .single();

        if (checkError && checkError.code !== "PGRST116") {
          // PGRST116 is "no rows returned"
          console.error("❌ Error checking for existing read receipt:", checkError);
          return;
        }

        if (existingReceiptCheck) {
          return;
        }

        const timestamp = new Date().toISOString();

        // Create optimistic read receipt for immediate UI feedback - restored from old version
        const optimisticReceipt: HelpRequestMessageReadReceipt = {
          id: Date.now(), // Temporary ID for optimistic update
          message_id: messageId,
          viewer_id: private_profile_id, // Use profile ID (this references profile IDs in database)
          class_id: helpRequest.class_id,
          created_at: timestamp
        };

        // Add optimistic update immediately for better UX
        addOptimisticReadReceipt(optimisticReceipt);

        // Persist to database - the trigger will handle broadcasting automatically
        try {
          await createReadReceipt({
            values: {
              message_id: messageId,
              viewer_id: private_profile_id, // Use profile ID instead of auth user ID
              class_id: helpRequest.class_id
            }
          });

          // Refetch initial data to ensure consistency
          refetchReadReceipts();
        } catch (dbError) {
          console.error("❌ Failed to save read receipt to database:", dbError);
          // Remove the optimistic update on database error
          refetchReadReceipts();
          // The RLS policy might be preventing access - this is expected for some cases
          if (dbError instanceof Error && dbError.message.includes("new row violates row-level security")) {
            // Expected for some RLS cases
          } else if (
            dbError instanceof Error &&
            (dbError.message.toLowerCase().includes("duplicate") || dbError.message.toLowerCase().includes("unique"))
          ) {
            // Duplicate receipt, which is fine
          }
        }
      } catch (error) {
        console.error("❌ Failed to mark message as read:", error);
        // Revert optimistic update on error
        refetchReadReceipts();
        // Don't throw here as read receipts are not critical for UX
      } finally {
        // Always remove from pending set when done
        setPendingReadReceipts((prev) => {
          const newSet = new Set(prev);
          newSet.delete(receiptKey);
          return newSet;
        });
      }
    },
    [
      createReadReceipt,
      userId,
      helpRequest.class_id,
      addOptimisticReadReceipt,
      refetchReadReceipts,
      channel,
      isConnected,
      pendingReadReceipts,
      setPendingReadReceipts,
      initialReadReceipts?.data,
      private_profile_id,
      supabase
    ]
  );

  return {
    broadcastMessages,
    broadcastReadReceipts,
    sendMessage,
    markMessageAsRead,
    isConnected,
    participants,
    // Return optimistic read receipts for this help request, excluding current user's own receipts
    readReceipts: optimisticReadReceipts.filter(
      (receipt) => receipt.viewer_id !== private_profile_id // Exclude current user's read receipts from UI (database uses profile IDs)
    )
  };
}
