"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches messages for a specific help request with cross-tab realtime sync.
 *
 * Takes a `helpRequestId` parameter. When null, the query is disabled.
 * When the component unmounts, TanStack Query's gcTime automatically evicts the
 * data after 5 minutes -- this replaces the old unbounded
 * `_helpRequestMessageControllers` Map that was never cleaned up.
 *
 * Replaces: OfficeHoursController.loadMessagesForHelpRequest()
 */
export function useHelpRequestMessagesQuery(helpRequestId: number | null) {
  const { classId, supabase, classRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"help_request_messages">({
    queryKey: ["office_hours", classId, "help_request_messages", helpRequestId],
    table: "help_request_messages",
    queryFn: () =>
      supabase.from("help_request_messages").select("*").eq("class_id", classId).eq("help_request_id", helpRequestId!),
    classRtc,
    supabase,
    scope: "scoped",
    enabled: helpRequestId != null,
    debounceMs: 50, // Chat needs low latency
    gcTime: 5 * 60 * 1000, // 5 min auto-eviction -- THIS FIXES THE LEAK
    realtimeFilter: (row) => row.class_id === classId && row.help_request_id === helpRequestId
  });
}
