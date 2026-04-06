"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Assignment } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches all assignments for the current course with cross-tab realtime sync.
 * Results are ordered by due_date (ascending), then id (ascending).
 * Replaces: CourseController.assignments
 */
export function useAssignmentsQuery() {
  const { courseId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"assignments", Assignment>({
    queryKey: ["course", courseId, "assignments"],
    table: "assignments",
    queryFn: () =>
      supabase
        .from("assignments")
        .select("*")
        .eq("class_id", courseId)
        .order("due_date", { ascending: true })
        .order("id", { ascending: true }),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).class_id === courseId
  });
}
