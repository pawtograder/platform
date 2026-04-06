"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type StudentDeadlineExtension = Database["public"]["Tables"]["student_deadline_extensions"]["Row"];

/**
 * Fetches and subscribes to student deadline extensions for the current course.
 *
 * - Staff: all extensions in the class (with SSR initialData).
 * - Student with profileId: only their own extensions.
 */
export function useStudentDeadlineExtensionsQuery() {
  const { courseId, supabase, classRtc, isStaff, profileId } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"student_deadline_extensions", StudentDeadlineExtension>({
    queryKey: ["course", courseId, "student_deadline_extensions", isStaff ? "staff" : profileId],
    table: "student_deadline_extensions",
    queryFn: () => {
      let query = supabase.from("student_deadline_extensions").select("*").eq("class_id", courseId);
      if (!isStaff && profileId) {
        query = query.or(`student_id.eq.${profileId}`);
      }
      return query;
    },
    classRtc,
    supabase,
    scope: "class"
  });
}
