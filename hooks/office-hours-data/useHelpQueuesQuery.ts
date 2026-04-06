"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all help queues for the current class with cross-tab realtime sync.
 * Replaces: OfficeHoursController.helpQueues
 */
export function useHelpQueuesQuery() {
  const { classId, supabase, classRtc, officeHoursRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"help_queues">({
    queryKey: ["office_hours", classId, "help_queues"],
    table: "help_queues",
    queryFn: () => supabase.from("help_queues").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped",
    realtimeFilter: (row) => row.class_id === classId,
    additionalRealTimeControllers: officeHoursRtc ? [officeHoursRtc] : undefined
  });
}
