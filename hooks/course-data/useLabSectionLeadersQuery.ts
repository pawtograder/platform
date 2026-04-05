"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { LabSectionLeader } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches all lab section leaders for the current course with cross-tab realtime sync.
 * Has a realtimeFilter to match rows by class_id since the table may receive
 * broadcasts for other classes.
 * Replaces: CourseController.labSectionLeaders
 */
export function useLabSectionLeadersQuery() {
  const { courseId, supabase, classRtc, initialData } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"lab_section_leaders", LabSectionLeader>({
    queryKey: ["course", courseId, "lab_section_leaders"],
    table: "lab_section_leaders",
    queryFn: () => supabase.from("lab_section_leaders").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).class_id === courseId,
    initialData: initialData?.labSectionLeaders
  });
}
