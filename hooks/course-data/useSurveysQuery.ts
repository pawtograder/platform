"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type Survey = Database["public"]["Tables"]["surveys"]["Row"];

/**
 * Fetches surveys for the current course with cross-tab realtime sync.
 * Only includes non-deleted surveys, ordered by created_at descending.
 * Replaces: CourseController.surveys
 */
export function useSurveysQuery() {
  const { courseId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"surveys", Survey>({
    queryKey: ["course", courseId, "surveys"],
    table: "surveys",
    queryFn: () =>
      supabase
        .from("surveys")
        .select("*")
        .eq("class_id", courseId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).class_id === courseId
  });
}
