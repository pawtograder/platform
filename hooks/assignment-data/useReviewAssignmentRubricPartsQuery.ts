"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type ReviewAssignmentRubricPartRow = Database["public"]["Tables"]["review_assignment_rubric_parts"]["Row"];

/**
 * Fetches rubric parts for a specific review assignment with realtime sync.
 * Uses TanStack Query's gcTime for auto-cleanup, replacing the manual ref counting
 * pattern in AssignmentController._reviewAssignmentRubricPartsByReviewAssignmentId.
 *
 * Replaces: AssignmentController.getReviewAssignmentRubricPartsController()
 */
export function useReviewAssignmentRubricPartsQuery(reviewAssignmentId: number | null) {
  const { courseId, supabase, classRtc } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"review_assignment_rubric_parts", ReviewAssignmentRubricPartRow>({
    queryKey: ["course", courseId, "review_assignment_rubric_parts", reviewAssignmentId],
    table: "review_assignment_rubric_parts",
    queryFn: () =>
      supabase.from("review_assignment_rubric_parts").select("*").eq("review_assignment_id", reviewAssignmentId!),
    classRtc,
    supabase,
    scope: "class",
    enabled: reviewAssignmentId != null,
    realtimeFilter: (row) => (row as Record<string, unknown>).review_assignment_id === reviewAssignmentId,
    gcTime: 5 * 60 * 1000 // 5 min — auto-cleanup replaces manual ref counting
  });
}
