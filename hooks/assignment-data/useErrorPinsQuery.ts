"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "@/hooks/assignment-data/useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type ErrorPinRow = Database["public"]["Tables"]["error_pins"]["Row"];

/**
 * Fetches error pins for the current assignment with realtime sync.
 * Replaces: AssignmentController.errorPins
 */
export function useErrorPinsQuery() {
  const { assignmentId, courseId, supabase, classRtc } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"error_pins", ErrorPinRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "error_pins"],
    table: "error_pins",
    queryFn: () => supabase.from("error_pins").select("*").eq("assignment_id", assignmentId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).assignment_id === assignmentId
  });
}
