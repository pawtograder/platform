"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Fetches and subscribes to repositories for the current course.
 *
 * - Staff: all repositories in the class (with SSR initialData).
 * - Students: individual repos matching their profileId, plus group repos.
 */
export function useRepositoriesQuery() {
  const { courseId, supabase, classRtc, isStaff, profileId, initialData } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"repositories">({
    queryKey: ["course", courseId, "repositories", isStaff ? "staff" : profileId],
    table: "repositories",
    queryFn: () => {
      let query = supabase.from("repositories").select("*");
      if (isStaff) {
        query = query.eq("class_id", courseId);
      } else if (profileId) {
        query = query.eq("class_id", courseId).or(`profile_id.eq.${profileId},assignment_group_id.not.is.null`);
      } else {
        query = query.eq("class_id", courseId);
      }
      return query;
    },
    classRtc,
    supabase,
    scope: "class",
    initialData: isStaff ? initialData?.repositories : undefined
  });
}
