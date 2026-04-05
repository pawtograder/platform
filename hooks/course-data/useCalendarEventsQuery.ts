"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type CalendarEvent = Database["public"]["Tables"]["calendar_events"]["Row"];

/**
 * Fetches calendar events for the current course with cross-tab realtime sync.
 * Students can only see office_hours events; staff can see all.
 * Results are ordered by start_time ascending.
 * Replaces: CourseController.calendarEvents
 */
export function useCalendarEventsQuery() {
  const { courseId, supabase, classRtc, isStaff } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"calendar_events", CalendarEvent>({
    queryKey: ["course", courseId, "calendar_events", isStaff ? "all" : "office_hours"],
    table: "calendar_events",
    queryFn: () => {
      let query = supabase.from("calendar_events").select("*").eq("class_id", courseId);
      if (!isStaff) {
        query = query.eq("calendar_type", "office_hours");
      }
      return query.order("start_time", { ascending: true }).limit(1000);
    },
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: isStaff
      ? (row) => (row as Record<string, unknown>).class_id === courseId
      : (row) =>
          (row as Record<string, unknown>).class_id === courseId &&
          (row as Record<string, unknown>).calendar_type === "office_hours"
  });
}
