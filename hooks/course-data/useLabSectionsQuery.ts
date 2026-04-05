"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { LabSection } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches all lab sections for the current course with cross-tab realtime sync.
 * Replaces: CourseController.labSections
 */
export function useLabSectionsQuery() {
  const { courseId, supabase, classRtc, initialData } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"lab_sections", LabSection>({
    queryKey: ["course", courseId, "lab_sections"],
    table: "lab_sections",
    queryFn: () => supabase.from("lab_sections").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class",
    initialData: initialData?.labSections
  });
}
