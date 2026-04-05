"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all help request templates for the current class.
 * Replaces: OfficeHoursController.helpRequestTemplates
 */
export function useHelpRequestTemplatesQuery() {
  const { classId, supabase, classRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"help_request_templates">({
    queryKey: ["office_hours", classId, "help_request_templates"],
    table: "help_request_templates",
    queryFn: () => supabase.from("help_request_templates").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped",
    realtimeFilter: (row) => row.class_id === classId
  });
}
