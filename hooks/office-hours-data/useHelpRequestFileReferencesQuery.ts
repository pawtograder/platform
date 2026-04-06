"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all help request file references for the current class.
 * Replaces: OfficeHoursController.helpRequestFileReferences
 */
export function useHelpRequestFileReferencesQuery() {
  const { classId, supabase, classRtc, officeHoursRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"help_request_file_references">({
    queryKey: ["office_hours", classId, "help_request_file_references"],
    table: "help_request_file_references",
    queryFn: () => supabase.from("help_request_file_references").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped",
    realtimeFilter: (row) => row.class_id === classId,
    additionalRealTimeControllers: officeHoursRtc ? [officeHoursRtc] : undefined
  });
}
