"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Update mutation for discussion_thread_teasers.
 */
export function useDiscussionThreadTeaserUpdate() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "discussion_threads",
    queryKey: ["course", courseId, "discussion_thread_teasers"],
    mutationType: "update",
    supabase
  });
}
