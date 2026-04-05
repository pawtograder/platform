"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { DiscussionThread } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches all discussion thread teasers for the current course with cross-tab realtime sync.
 * Replaces: CourseController.discussionThreadTeasers + useTableControllerTableValues()
 */
export function useDiscussionThreadTeasersQuery() {
  const { courseId, supabase, classRtc, initialData } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"discussion_threads", DiscussionThread>({
    queryKey: ["course", courseId, "discussion_thread_teasers"],
    table: "discussion_threads",
    queryFn: () => supabase.from("discussion_threads").select("*").eq("root_class_id", courseId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).root_class_id === courseId,
    initialData: initialData?.discussionThreadTeasers
  });
}
