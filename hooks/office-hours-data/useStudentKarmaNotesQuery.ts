"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all student karma notes for the current class.
 * Replaces: OfficeHoursController.studentKarmaNotes
 */
export function useStudentKarmaNotesQuery() {
  const { classId, supabase, classRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"student_karma_notes">({
    queryKey: ["office_hours", classId, "student_karma_notes"],
    table: "student_karma_notes",
    queryFn: () => supabase.from("student_karma_notes").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped"
  });
}
