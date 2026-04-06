"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Tag } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches all tags for the current course with cross-tab realtime sync.
 * Replaces: CourseController.tags + useTags()
 */
export function useTagsQuery() {
  const { courseId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"tags", Tag>({
    queryKey: ["course", courseId, "tags"],
    table: "tags",
    queryFn: () => supabase.from("tags").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class"
  });
}
