"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Update mutation for discussion_thread_read_status.
 */
export function useDiscussionThreadReadStatusUpdate() {
  const { courseId, userId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "discussion_thread_read_status",
    queryKey: ["course", courseId, "discussion_thread_read_status", userId],
    mutationType: "update",
    supabase
  });
}
