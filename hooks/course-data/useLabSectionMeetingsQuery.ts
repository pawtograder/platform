"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { LabSectionMeeting } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches all lab section meetings for the current course with cross-tab realtime sync.
 * Replaces: CourseController.labSectionMeetings
 */
export function useLabSectionMeetingsQuery() {
  const { courseId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"lab_section_meetings", LabSectionMeeting>({
    queryKey: ["course", courseId, "lab_section_meetings"],
    table: "lab_section_meetings",
    queryFn: () => supabase.from("lab_section_meetings").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class"
  });
}
