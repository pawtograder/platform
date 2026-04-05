"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all help request work sessions for the current class.
 * Replaces: OfficeHoursController.helpRequestWorkSessions
 */
export function useHelpRequestWorkSessionsQuery() {
  const { classId, supabase, classRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"help_request_work_sessions">({
    queryKey: ["office_hours", classId, "help_request_work_sessions"],
    table: "help_request_work_sessions",
    queryFn: () => supabase.from("help_request_work_sessions").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped",
    realtimeFilter: (row) => row.class_id === classId
  });
}
