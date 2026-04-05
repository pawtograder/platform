"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useAssignmentDataContext } from "./useAssignmentDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type ErrorPinRuleRow = Database["public"]["Tables"]["error_pin_rules"]["Row"];

/**
 * Fetches error pin rules for the current assignment via inner join on error_pins.
 * The join filters rules to only those whose parent error_pin belongs to this assignment.
 * Replaces: AssignmentController.errorPinRules
 */
export function useErrorPinRulesQuery() {
  const { assignmentId, courseId, supabase, classRtc } = useAssignmentDataContext();

  return useSupabaseRealtimeQuery<"error_pin_rules", ErrorPinRuleRow>({
    queryKey: ["course", courseId, "assignment", assignmentId, "error_pin_rules"],
    table: "error_pin_rules",
    queryFn: () =>
      supabase
        .from("error_pin_rules")
        .select("*,error_pins!inner(assignment_id)")
        .eq("error_pins.assignment_id", assignmentId),
    classRtc,
    supabase,
    scope: "class"
  });
}
