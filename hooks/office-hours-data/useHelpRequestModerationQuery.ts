"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all help request moderation records for the current class.
 * Replaces: OfficeHoursController.helpRequestModeration
 */
export function useHelpRequestModerationQuery() {
  const { classId, supabase, classRtc, officeHoursRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"help_request_moderation">({
    queryKey: ["office_hours", classId, "help_request_moderation"],
    table: "help_request_moderation",
    queryFn: () => supabase.from("help_request_moderation").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped",
    additionalRealTimeControllers: officeHoursRtc ? [officeHoursRtc] : undefined
  });
}
