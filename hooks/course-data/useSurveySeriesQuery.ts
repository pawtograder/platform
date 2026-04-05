"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type SurveySeries = Database["public"]["Tables"]["survey_series"]["Row"];

/**
 * Fetches survey series for the current course with cross-tab realtime sync.
 * Ordered by name.
 * Replaces: CourseController.surveySeries
 */
export function useSurveySeriesQuery() {
  const { courseId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"survey_series", SurveySeries>({
    queryKey: ["course", courseId, "survey_series"],
    table: "survey_series",
    queryFn: () => supabase.from("survey_series").select("*").eq("class_id", courseId).order("name"),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).class_id === courseId
  });
}
