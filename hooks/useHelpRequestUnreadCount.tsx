"use client";

import { useMemo } from "react";
import { useHelpRequestMessages, useHelpRequestReadReceipts } from "@/hooks/useOfficeHoursRealtime";
import { useClassProfiles } from "@/hooks/useClassProfiles";

/**
 * Hook to calculate unread message count for a specific help request
 */
export function useHelpRequestUnreadCount(helpRequestId: number | undefined): number {
  const { private_profile_id } = useClassProfiles();
  const messages = useHelpRequestMessages(helpRequestId);
  const readReceipts = useHelpRequestReadReceipts(helpRequestId);

  return useMemo(() => {
    if (!helpRequestId || !private_profile_id) return 0;

    // Filter read receipts for current user
    const userReadReceipts = readReceipts.filter((receipt) => receipt.viewer_id === private_profile_id);
    const readMessageIds = new Set(userReadReceipts.map((r) => r.message_id));

    // Count unread messages (messages not authored by current user and not read)
    const unreadCount = messages.filter(
      (msg) => msg.author !== private_profile_id && !readMessageIds.has(msg.id)
    ).length;

    return unreadCount;
  }, [helpRequestId, private_profile_id, messages, readReceipts]);
}
