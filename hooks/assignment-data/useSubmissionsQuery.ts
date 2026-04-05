"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];

/**
 * Fetches active submissions for the current assignment with realtime sync.
 * Replaces: AssignmentController.submissions
 */
export function useSubmissionsQuery() {
  const { assignmentId, courseId, supabase, classRtc, initialData } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"submissions", SubmissionRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "submissions"],
    table: "submissions",
    queryFn: () => supabase.from("submissions").select("*").eq("assignment_id", assignmentId).eq("is_active", true),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => {
      const r = row as Record<string, unknown>;
      return r.assignment_id === assignmentId && r.is_active === true;
    },
    initialData: initialData?.submissions
  });
}
