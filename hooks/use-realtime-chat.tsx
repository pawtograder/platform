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
  roomName: string;
  username: string; // Display name for UI
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
  tempId?: string; // For optimistic updates
}

// Broadcast read receipt type for real-time communication
export interface BroadcastReadReceipt {
  id: string;
  messageId: number;
  userId: string; // Auth user ID
  userName: string; // Display name
  classId: number;
  createdAt: string;
  tempId?: string; // For optimistic updates
}

const EVENT_MESSAGE_TYPE = "message";
const EVENT_READ_RECEIPT_TYPE = "read_receipt";

export function useRealtimeChat({ roomName, username, helpRequest, messages = [] }: UseRealtimeChatProps) {
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

  // Get message IDs from the passed messages for read receipt fetching
  const messageIds = useMemo(() => {
    return messages.map((msg) => msg.id).filter((id): id is number => id !== null);
  }, [messages]);

  // Fetch read receipts for messages in this help request
  // The new RLS policy will automatically filter to only accessible read receipts
  const { data: readReceipts, refetch: refetchReadReceipts } = useList<HelpRequestMessageReadReceipt>({
    resource: "help_request_message_read_receipts",
    filters:
      messageIds.length > 0
        ? [{ field: "message_id", operator: "in", value: messageIds }]
        : [
            { field: "message_id", operator: "eq", value: -1 } // No results if no messages yet
          ],
    pagination: { pageSize: 1000 },
    liveMode: "auto",
    queryOptions: {
      enabled: messageIds.length > 0 // Only fetch when we have message IDs
    }
  });

  // Merge database read receipts with broadcast read receipts for real-time updates
  const allReadReceipts = useMemo(() => {
    const mergedReceipts: HelpRequestMessageReadReceipt[] = [...(readReceipts?.data || [])];

    // Add broadcast receipts that aren't already in database
    broadcastReadReceipts.forEach((broadcastReceipt) => {
      // Note: Database uses profile IDs, broadcast uses auth user IDs
      // For the current user, check if we already have a receipt for this message
      // We can't easily convert between user ID and profile ID here, so we'll check by message and timing
      const isDuplicate = (readReceipts?.data || []).some(
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
  }, [readReceipts?.data, broadcastReadReceipts, userId, private_profile_id]);

  // Optimistic read receipts for immediate UI feedback
  const [optimisticReadReceipts, addOptimisticReadReceipt] = useOptimistic(
    allReadReceipts,
    (state, newReceipt: HelpRequestMessageReadReceipt) => [...state, newReceipt]
  );

  // TODO: Postgres trigger for this to ensure it is recorded in postgres

  useEffect(() => {
    const newChannel = supabase.channel(roomName, {
      config: {
        broadcast: { self: true }
      }
    });

    newChannel
      .on("broadcast", { event: EVENT_MESSAGE_TYPE }, (payload) => {
        const message = payload.payload as BroadcastMessage;
        // Only add if it's not our own message (we add it optimistically)
        if (message.user.id !== userId) {
          setBroadcastMessages((current) => [...current, message]);
        }
      })
      .on("broadcast", { event: EVENT_READ_RECEIPT_TYPE }, (payload) => {
        const receipt = payload.payload as BroadcastReadReceipt;
        // Only add if it's not our own receipt (we add it optimistically)
        if (receipt.userId !== userId) {
          // Add to broadcast receipts for real-time updates
          setBroadcastReadReceipts((current) => [...current, receipt]);
        }
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
  }, [roomName, userId, supabase]); // Use userId instead of username

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

      const tempId = crypto.randomUUID();

      const broadcastMessage: BroadcastMessage = {
        id: tempId,
        content,
        user: {
          id: userId, // Use auth user ID for broadcast/presence
          name: username // Display name for UI
        },
        createdAt: new Date().toISOString(),
        replyToMessageId: replyToMessageId || null,
        helpRequestId: helpRequest.id,
        classId: helpRequest.class_id,
        tempId
      };

      // Add message optimistically for immediate UI feedback
      setBroadcastMessages((current) => [...current, broadcastMessage]);

      try {
        // Send broadcast message for real-time delivery
        const broadcastResult = await channel.send({
          type: "broadcast",
          event: EVENT_MESSAGE_TYPE,
          payload: broadcastMessage
        });

        if (broadcastResult !== "ok") {
          console.error("Failed to send broadcast message:", broadcastResult);
        }

        // Persist message to database for persistence and features
        await createMessage({
          values: {
            message: content,
            help_request_id: helpRequest.id,
            author: private_profile_id, // This must be a profile ID matching the database schema
            class_id: helpRequest.class_id,
            requestor: helpRequest.creator,
            instructors_only: false,
            reply_to_message_id: replyToMessageId || null
          }
        });
      } catch (error) {
        console.error("❌ Failed to send message:", error);
        // Remove the optimistic message on error
        setBroadcastMessages((current) => current.filter((msg) => msg.tempId !== tempId));

        // You might want to show a toast notification here
        throw error; // Re-throw so UI can handle the error
      }
    },
    [channel, isConnected, userId, username, helpRequest, createMessage, private_profile_id]
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
        const existingReceipt = (readReceipts?.data || []).find(
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
        const tempId = crypto.randomUUID();
        const timestamp = new Date().toISOString();

        // Create broadcast read receipt for real-time delivery
        const broadcastReceipt: BroadcastReadReceipt = {
          id: tempId,
          messageId: messageId,
          userId: userId,
          userName: username,
          classId: helpRequest.class_id,
          createdAt: timestamp,
          tempId
        };

        // Create optimistic read receipt for immediate UI feedback
        const optimisticReceipt: HelpRequestMessageReadReceipt = {
          id: Date.now(), // Temporary ID for optimistic update
          message_id: messageId,
          viewer_id: private_profile_id, // Use profile ID (this references profile IDs in database)
          class_id: helpRequest.class_id,
          created_at: timestamp
        };

        // Add optimistic update immediately
        addOptimisticReadReceipt(optimisticReceipt);

        // Add to broadcast receipts for real-time delivery
        setBroadcastReadReceipts((current) => [...current, broadcastReceipt]);

        // Send broadcast read receipt for real-time delivery
        const broadcastResult = await channel.send({
          type: "broadcast",
          event: EVENT_READ_RECEIPT_TYPE,
          payload: broadcastReceipt
        });

        if (broadcastResult !== "ok") {
          console.error("Failed to broadcast read receipt:", broadcastResult);
        }

        // Then persist to database for durability
        try {
          await createReadReceipt({
            values: {
              message_id: messageId,
              viewer_id: private_profile_id, // Use profile ID instead of auth user ID
              class_id: helpRequest.class_id
            }
          });

          // Refetch to sync with server (this will replace optimistic data with real data)
          refetchReadReceipts();
        } catch (dbError) {
          console.error("❌ Failed to save read receipt to database:", dbError);
          // Remove the optimistic updates on database error
          setBroadcastReadReceipts((current) =>
            current.filter((receipt) => !(receipt.messageId === messageId && receipt.userId === userId))
          );
          // The RLS policy might be preventing access - this is expected for some cases
          if (dbError instanceof Error && dbError.message.includes("new row violates row-level security")) {
          } else if (
            dbError instanceof Error &&
            (dbError.message.toLowerCase().includes("duplicate") || dbError.message.toLowerCase().includes("unique"))
          ) {
          }
        }
      } catch (error) {
        console.error("❌ Failed to mark message as read:", error);
        // Remove the optimistic read receipt on error
        setBroadcastReadReceipts((current) =>
          current.filter((receipt) => !(receipt.messageId === messageId && receipt.userId === userId))
        );
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
      username,
      helpRequest.class_id,
      addOptimisticReadReceipt,
      refetchReadReceipts,
      channel,
      isConnected,
      setBroadcastReadReceipts,
      pendingReadReceipts,
      setPendingReadReceipts,
      readReceipts?.data,
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
    // Return read receipts for this help request, excluding current user's own receipts
    readReceipts: optimisticReadReceipts.filter(
      (receipt) => receipt.viewer_id !== private_profile_id // Exclude current user's read receipts from UI (database uses profile IDs)
    )
  };
}
