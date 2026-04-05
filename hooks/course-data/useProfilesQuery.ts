"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { UserProfile } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches all profiles for the current course with cross-tab realtime sync.
 * Replaces: CourseController.profiles + useAllProfilesForClass()
 */
export function useProfilesQuery() {
  const { courseId, supabase, classRtc, initialData } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"profiles", UserProfile>({
    queryKey: ["course", courseId, "profiles"],
    table: "profiles",
    queryFn: () => supabase.from("profiles").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class",
    initialData: initialData?.profiles
  });
}
