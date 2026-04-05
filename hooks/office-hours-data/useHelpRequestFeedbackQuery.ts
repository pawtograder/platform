"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all help request feedback for the current class.
 * Replaces: OfficeHoursController.helpRequestFeedback
 */
export function useHelpRequestFeedbackQuery() {
  const { classId, supabase, classRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"help_request_feedback">({
    queryKey: ["office_hours", classId, "help_request_feedback"],
    table: "help_request_feedback",
    queryFn: () => supabase.from("help_request_feedback").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped"
  });
}
