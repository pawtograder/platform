"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Fetches and subscribes to gradebook_columns for the current course.
 * Receives SSR initialData when available.
 */
export function useGradebookColumnsQuery() {
  const { courseId, supabase, classRtc, initialData } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"gradebook_columns">({
    queryKey: ["course", courseId, "gradebook_columns"],
    table: "gradebook_columns",
    queryFn: () => supabase.from("gradebook_columns").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class",
    initialData: initialData?.gradebookColumns
  });
}
