"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all help requests for the current class with cross-tab realtime sync.
 * Uses debounceMs: 0 for immediate updates (matches original TableController config).
 * Replaces: OfficeHoursController.helpRequests
 */
export function useHelpRequestsQuery() {
  const { classId, supabase, classRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"help_requests">({
    queryKey: ["office_hours", classId, "help_requests"],
    table: "help_requests",
    queryFn: () => supabase.from("help_requests").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped",
    debounceMs: 0,
    realtimeFilter: (row) => row.class_id === classId
  });
}
