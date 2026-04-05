"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];

/**
 * Fetches all review assignments for the current assignment (staff view, no assignee filter).
 * Replaces: AssignmentController.allReviewAssignments
 */
export function useAllReviewAssignmentsQuery() {
  const { assignmentId, courseId, supabase, classRtc, isStaff } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"review_assignments", ReviewAssignmentRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "all_review_assignments"],
    table: "review_assignments",
    queryFn: () => supabase.from("review_assignments").select("*").eq("assignment_id", assignmentId),
    classRtc,
    supabase,
    scope: "class",
    enabled: isStaff,
    realtimeFilter: (row) => (row as Record<string, unknown>).assignment_id === assignmentId
  });
}
