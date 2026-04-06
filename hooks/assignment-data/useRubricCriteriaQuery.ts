"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type RubricCriteriaRow = Database["public"]["Tables"]["rubric_criteria"]["Row"];

/**
 * Fetches rubric criteria for the current assignment with realtime sync.
 * Replaces: AssignmentController.rubricCriteriaController
 */
export function useRubricCriteriaQuery() {
  const { assignmentId, courseId, supabase, classRtc } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"rubric_criteria", RubricCriteriaRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "rubric_criteria"],
    table: "rubric_criteria",
    queryFn: () => supabase.from("rubric_criteria").select("*").eq("assignment_id", assignmentId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).assignment_id === assignmentId
  });
}
