"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type LeaderboardRow = Database["public"]["Tables"]["assignment_leaderboard"]["Row"];

/**
 * Fetches leaderboard entries for the current assignment, sorted by autograder_score descending.
 * Replaces: AssignmentController.leaderboard
 */
export function useLeaderboardQuery() {
  const { assignmentId, courseId, supabase, classRtc } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"assignment_leaderboard", LeaderboardRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "leaderboard"],
    table: "assignment_leaderboard",
    queryFn: () =>
      supabase
        .from("assignment_leaderboard")
        .select("*")
        .eq("assignment_id", assignmentId)
        .order("autograder_score", { ascending: false }),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).assignment_id === assignmentId
  });
}
