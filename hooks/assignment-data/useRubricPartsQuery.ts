"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type RubricPartRow = Database["public"]["Tables"]["rubric_parts"]["Row"];

/**
 * Fetches rubric parts for the current assignment with realtime sync.
 * Replaces: AssignmentController.rubricPartsController
 */
export function useRubricPartsQuery() {
  const { assignmentId, courseId, supabase, classRtc, initialData } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"rubric_parts", RubricPartRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "rubric_parts"],
    table: "rubric_parts",
    queryFn: () => supabase.from("rubric_parts").select("*").eq("assignment_id", assignmentId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).assignment_id === assignmentId,
    initialData: initialData?.rubricParts
  });
}
