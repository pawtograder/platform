"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type RegradeRequestRow = Database["public"]["Tables"]["submission_regrade_requests"]["Row"];

/**
 * Fetches regrade requests for the current assignment with realtime sync.
 * Replaces: AssignmentController.regradeRequests
 */
export function useRegradeRequestsQuery() {
  const { assignmentId, courseId, supabase, classRtc } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"submission_regrade_requests", RegradeRequestRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "regrade_requests"],
    table: "submission_regrade_requests",
    queryFn: () => supabase.from("submission_regrade_requests").select("*").eq("assignment_id", assignmentId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).assignment_id === assignmentId
  });
}
