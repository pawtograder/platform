"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all student help activity records for the current class.
 * Replaces: OfficeHoursController.studentHelpActivity
 */
export function useStudentHelpActivityQuery() {
  const { classId, supabase, classRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"student_help_activity">({
    queryKey: ["office_hours", classId, "student_help_activity"],
    table: "student_help_activity",
    queryFn: () => supabase.from("student_help_activity").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped"
  });
}
