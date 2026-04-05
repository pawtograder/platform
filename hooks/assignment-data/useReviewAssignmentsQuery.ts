"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];

/**
 * Fetches review assignments for the current user on the current assignment.
 * Filtered by both assignment_id and the current user's profileId.
 * Replaces: AssignmentController.reviewAssignments
 */
export function useReviewAssignmentsQuery() {
  const { assignmentId, courseId, profileId, supabase, classRtc } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"review_assignments", ReviewAssignmentRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "review_assignments", profileId],
    table: "review_assignments",
    queryFn: () =>
      supabase
        .from("review_assignments")
        .select("*")
        .eq("assignment_id", assignmentId)
        .eq("assignee_profile_id", profileId!),
    classRtc,
    supabase,
    scope: "class",
    enabled: profileId != null,
    realtimeFilter: (row) => {
      const r = row as Record<string, unknown>;
      return r.assignment_id === assignmentId && r.assignee_profile_id === profileId;
    }
  });
}
