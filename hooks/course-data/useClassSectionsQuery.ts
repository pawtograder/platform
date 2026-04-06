"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "@/hooks/course-data/useCourseDataContext";
import type { ClassSection } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches all class sections for the current course with cross-tab realtime sync.
 * Replaces: CourseController.classSections
 */
export function useClassSectionsQuery() {
  const { courseId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"class_sections", ClassSection>({
    queryKey: ["course", courseId, "class_sections"],
    table: "class_sections",
    queryFn: () => supabase.from("class_sections").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class"
  });
}
