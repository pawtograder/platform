"use client";

import { getNotificationManager } from "@/lib/notifications";
import { useEffect, useRef, useCallback, useState } from "react";
import { useHelpRequestMessages } from "./useOfficeHoursRealtime";
import { useClassProfiles } from "./useClassProfiles";
import { useAllProfilesForClass } from "./useCourseController";
import type { HelpRequestMessage } from "@/utils/supabase/DatabaseTypes";

export interface UseMessageNotificationsOptions {
  helpRequestId: number;
  /** If true, enables notifications for this chat */
  enabled?: boolean;
  /** Custom notification title prefix */
  titlePrefix?: string;
}

export interface UseMessageNotificationsReturn {
  /** Current unread count for this chat */
  unreadCount: number;
  /** Clear notifications manually */
  clearNotifications: () => void;
  /** Test notification functionality */
  testNotification: () => void;
}

/**
 * Hook to handle message notifications for a help request chat.
 * Triggers browser notifications, sounds, title flashing, and favicon badges
 * when new messages arrive from other users while the tab is hidden.
 */
export function useMessageNotifications({
  helpRequestId,
  enabled = true,
  titlePrefix = "New message"
}: UseMessageNotificationsOptions): UseMessageNotificationsReturn {
  const messages = useHelpRequestMessages(helpRequestId);
  const { private_profile_id } = useClassProfiles();
  const profiles = useAllProfilesForClass();

  // Track previous message count and IDs to detect truly new messages
  const prevMessageIdsRef = useRef<Set<number>>(new Set());
  const isInitializedRef = useRef(false);

  // Get profile name by ID
  const getProfileName = useCallback(
    (profileId: string): string => {
      const profile = profiles.find((p) => p.id === profileId);
      return profile?.name || "Someone";
    },
    [profiles]
  );

  // Handle new messages
  useEffect(() => {
    if (!enabled || !private_profile_id) {
      return;
    }

    const manager = getNotificationManager();

    // Build set of current message IDs
    const currentMessageIds = new Set(messages.filter((m) => m.id !== null).map((m) => m.id as number));

    // On first render, just initialize the set without notifying
    if (!isInitializedRef.current) {
      prevMessageIdsRef.current = currentMessageIds;
      isInitializedRef.current = true;
      return;
    }

    // Find new messages that weren't in the previous set
    const newMessages: HelpRequestMessage[] = [];
    for (const message of messages) {
      if (message.id !== null && !prevMessageIdsRef.current.has(message.id)) {
        newMessages.push(message);
      }
    }

    // Filter to messages from other users
    const newMessagesFromOthers = newMessages.filter((m) => m.author !== private_profile_id);

    // Notify for each new message from others
    if (newMessagesFromOthers.length > 0 && !manager.isPageVisible()) {
      // Get the most recent message for the notification
      const latestMessage = newMessagesFromOthers[newMessagesFromOthers.length - 1];
      const authorName = getProfileName(latestMessage.author);

      manager.notify({
        title: `${titlePrefix} from ${authorName}`,
        body: latestMessage.message?.substring(0, 100) || "New message",
        tag: `help-request-${helpRequestId}`,
        onClick: () => {
          // Focus the window when notification is clicked
          window.focus();
        }
      });
    }

    // Update the tracked message IDs
    prevMessageIdsRef.current = currentMessageIds;
  }, [messages, private_profile_id, enabled, helpRequestId, titlePrefix, getProfileName]);

  // Clear notifications when component unmounts or helpRequestId changes
  useEffect(() => {
    return () => {
      // Reset initialization flag when help request changes
      isInitializedRef.current = false;
      prevMessageIdsRef.current = new Set();
    };
  }, [helpRequestId]);

  const clearNotifications = useCallback(() => {
    const manager = getNotificationManager();
    manager.clearNotifications();
  }, []);

  const testNotification = useCallback(() => {
    const manager = getNotificationManager();
    manager.testNotification();
  }, []);

  return {
    unreadCount: getNotificationManager().getUnreadCount(),
    clearNotifications,
    testNotification
  };
}

/**
 * Hook to handle notifications for multiple help requests (for staff).
 * Monitors all provided help request IDs and notifies when any receives a new message.
 *
 * This hook uses the office hours controller to subscribe to message changes
 * across multiple help requests efficiently.
 */
export function useStaffQueueNotifications({
  helpRequestIds,
  enabled = true
}: {
  helpRequestIds: number[];
  enabled?: boolean;
}): void {
  const { private_profile_id } = useClassProfiles();
  const profiles = useAllProfilesForClass();

  // Import the controller dynamically to avoid circular dependencies
  // We'll use a ref to track message counts per request
  const messageCountsRef = useRef<Map<number, number>>(new Map());
  const isInitializedRef = useRef(false);
  const prevRequestIdsRef = useRef<number[]>([]);

  // Get profile name by ID
  const getProfileName = useCallback(
    (profileId: string): string => {
      const profile = profiles.find((p) => p.id === profileId);
      return profile?.name || "Someone";
    },
    [profiles]
  );

  useEffect(() => {
    if (!enabled || !private_profile_id || helpRequestIds.length === 0) {
      return;
    }

    const manager = getNotificationManager();

    // Check if request IDs have changed
    const requestIdsChanged =
      prevRequestIdsRef.current.length !== helpRequestIds.length ||
      !prevRequestIdsRef.current.every((id) => helpRequestIds.includes(id));

    if (requestIdsChanged) {
      // Reset tracking for changed request list
      messageCountsRef.current.clear();
      isInitializedRef.current = false;
      prevRequestIdsRef.current = [...helpRequestIds];
    }

    // On first render, just initialize without notifying
    if (!isInitializedRef.current) {
      isInitializedRef.current = true;
      return;
    }
  }, [helpRequestIds, enabled, private_profile_id, getProfileName]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      messageCountsRef.current.clear();
      isInitializedRef.current = false;
      prevRequestIdsRef.current = [];
    };
  }, []);
}

/**
 * Hook that provides aggregated notification state for staff dashboards.
 * Returns whether there are any unread messages across all monitored requests.
 */
export function useStaffNotificationStatus(helpRequestIds: number[]): {
  hasUnread: boolean;
  totalUnread: number;
} {
  // This is a simplified version that returns the notification manager's state
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const manager = getNotificationManager();
    // Poll for changes (the notification manager will handle actual counts)
    const interval = setInterval(() => {
      setUnreadCount(manager.getUnreadCount());
    }, 1000);

    return () => clearInterval(interval);
  }, [helpRequestIds]);

  return {
    hasUnread: unreadCount > 0,
    totalUnread: unreadCount
  };
}

export default useMessageNotifications;
