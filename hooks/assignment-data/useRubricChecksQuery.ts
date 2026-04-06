"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type RubricCheckRow = Database["public"]["Tables"]["rubric_checks"]["Row"];

/**
 * Fetches rubric checks for the current assignment with realtime sync.
 * Replaces: AssignmentController.rubricChecksController
 */
export function useRubricChecksQuery() {
  const { assignmentId, courseId, supabase, classRtc } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"rubric_checks", RubricCheckRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "rubric_checks"],
    table: "rubric_checks",
    queryFn: () => supabase.from("rubric_checks").select("*").eq("assignment_id", assignmentId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).assignment_id === assignmentId
  });
}
