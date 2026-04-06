"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all help queue assignments for the current class.
 * Replaces: OfficeHoursController.helpQueueAssignments
 */
export function useHelpQueueAssignmentsQuery() {
  const { classId, supabase, classRtc, officeHoursRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"help_queue_assignments">({
    queryKey: ["office_hours", classId, "help_queue_assignments"],
    table: "help_queue_assignments",
    queryFn: () => supabase.from("help_queue_assignments").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped",
    realtimeFilter: (row) => row.class_id === classId,
    additionalRealTimeControllers: officeHoursRtc ? [officeHoursRtc] : undefined
  });
}
