"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all help request student associations for the current class.
 * Replaces: OfficeHoursController.helpRequestStudents
 */
export function useHelpRequestStudentsQuery() {
  const { classId, supabase, classRtc, officeHoursRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"help_request_students">({
    queryKey: ["office_hours", classId, "help_request_students"],
    table: "help_request_students",
    queryFn: () => supabase.from("help_request_students").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped",
    realtimeFilter: (row) => row.class_id === classId,
    additionalRealTimeControllers: officeHoursRtc ? [officeHoursRtc] : undefined
  });
}
