"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Update mutation for surveys.
 */
export function useSurveyUpdate() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "surveys",
    queryKey: ["course", courseId, "surveys"],
    mutationType: "update",
    supabase
  });
}
