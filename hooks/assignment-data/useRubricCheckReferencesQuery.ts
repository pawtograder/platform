"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type RubricCheckReferenceRow = Database["public"]["Tables"]["rubric_check_references"]["Row"];

/**
 * Fetches rubric check references for the current assignment with realtime sync.
 * Replaces: AssignmentController.rubricCheckReferencesController
 */
export function useRubricCheckReferencesQuery() {
  const { assignmentId, courseId, supabase, classRtc, initialData } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"rubric_check_references", RubricCheckReferenceRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "rubric_check_references"],
    table: "rubric_check_references",
    queryFn: () => supabase.from("rubric_check_references").select("*").eq("assignment_id", assignmentId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).assignment_id === assignmentId,
    initialData: initialData?.rubricCheckReferences
  });
}
