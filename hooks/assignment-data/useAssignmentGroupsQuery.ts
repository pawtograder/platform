"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type AssignmentGroupRow = Database["public"]["Tables"]["assignment_groups"]["Row"];

/**
 * Fetches assignment-scoped groups for the current assignment with realtime sync.
 * Replaces: AssignmentController.assignmentGroups
 */
export function useAssignmentScopedGroupsQuery() {
  const { assignmentId, courseId, supabase, classRtc, initialData } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"assignment_groups", AssignmentGroupRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "assignment_groups"],
    table: "assignment_groups",
    queryFn: () => supabase.from("assignment_groups").select("*").eq("assignment_id", assignmentId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).assignment_id === assignmentId,
    initialData: initialData?.assignmentGroups
  });
}
