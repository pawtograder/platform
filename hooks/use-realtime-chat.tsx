"use client";

import { createClient } from "@/utils/supabase/client";
import { useCallback, useEffect, useState } from "react";
import { useCreate } from "@refinedev/core";
import type { HelpRequest, HelpRequestMessageWithoutId } from "@/utils/supabase/DatabaseTypes";

interface UseRealtimeChatProps {
  roomName: string;
  username: string;
  helpRequest: HelpRequest;
}

export type ChatMessage = HelpRequestMessageWithoutId & { id: number | null };

export function useRealtimeChat({ roomName, username, helpRequest }: UseRealtimeChatProps) {
  const supabase = createClient();
  const [isConnected, setIsConnected] = useState(false);
  const [participants, setParticipants] = useState<string[]>([]);

  // Add Refine's useCreate hook for database persistence
  const { mutateAsync: createMessage } = useCreate({
    resource: "help_request_messages"
  });

  // TODO: Use channels + persistence, turn off real-time updates for the database tables
  // RLS on the channel https://supabase.com/docs/guides/realtime/authorization#broadcast

  useEffect(() => {
    const newChannel = supabase.channel(roomName, {
      config: {
        broadcast: { self: true }
      }
    });

    newChannel
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
          // Track user presence
          newChannel.track({ user_id: username });
        }
      });

    return () => {
      supabase.removeChannel(newChannel);
    };
  }, [roomName, username, supabase]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!isConnected) return;

      try {
        // Persist message to database - real-time updates will handle the rest
        await createMessage({
          values: {
            message: content,
            help_request_id: helpRequest.id,
            author: username,
            class_id: helpRequest.class_id,
            requestor: helpRequest.creator,
            instructors_only: false,
            reply_to_message_id: null
          }
        });
      } catch (error) {
        console.error("Failed to send message:", error);
        // Could add error handling here (e.g., show toast notification)
      }
    },
    [isConnected, username, helpRequest, createMessage]
  );

  return { sendMessage, isConnected, participants };
}
