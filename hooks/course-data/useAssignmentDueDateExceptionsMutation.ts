"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Insert mutation for assignment_due_date_exceptions.
 */
export function useAssignmentDueDateExceptionInsert() {
  const { courseId, supabase, isStaff, profileId } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "assignment_due_date_exceptions",
    queryKey: ["course", courseId, "assignment_due_date_exceptions", isStaff ? "staff" : profileId],
    mutationType: "insert",
    supabase
  });
}

/**
 * Delete mutation for assignment_due_date_exceptions.
 */
export function useAssignmentDueDateExceptionDelete() {
  const { courseId, supabase, isStaff, profileId } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "assignment_due_date_exceptions",
    queryKey: ["course", courseId, "assignment_due_date_exceptions", isStaff ? "staff" : profileId],
    mutationType: "delete",
    supabase
  });
}
