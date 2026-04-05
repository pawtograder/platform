"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type AssignmentDueDateException = Database["public"]["Tables"]["assignment_due_date_exceptions"]["Row"];

/**
 * Fetches and subscribes to assignment due date exceptions for the current course.
 *
 * - Staff: all exceptions in the class (with SSR initialData).
 * - Student with profileId: exceptions matching their profile or group-based exceptions.
 */
export function useAssignmentDueDateExceptionsQuery() {
  const { courseId, supabase, classRtc, isStaff, profileId, initialData } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"assignment_due_date_exceptions", AssignmentDueDateException>({
    queryKey: ["course", courseId, "assignment_due_date_exceptions", isStaff ? "staff" : profileId],
    table: "assignment_due_date_exceptions",
    queryFn: () => {
      let query = supabase.from("assignment_due_date_exceptions").select("*").eq("class_id", courseId);
      if (!isStaff && profileId) {
        query = query.or(`student_id.eq.${profileId},assignment_group_id.not.is.null`);
      }
      return query;
    },
    classRtc,
    supabase,
    scope: "class",
    initialData: initialData?.assignmentDueDateExceptions
  });
}
