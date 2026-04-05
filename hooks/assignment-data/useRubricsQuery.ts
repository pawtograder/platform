"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type RubricRow = Database["public"]["Tables"]["rubrics"]["Row"];

/**
 * Fetches rubrics for the current assignment with realtime sync.
 * Replaces: AssignmentController.rubricsController
 */
export function useRubricsQuery() {
  const { assignmentId, courseId, supabase, classRtc, initialData } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"rubrics", RubricRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "rubrics"],
    table: "rubrics",
    queryFn: () => supabase.from("rubrics").select("*").eq("assignment_id", assignmentId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).assignment_id === assignmentId,
    initialData: initialData?.rubrics
  });
}
