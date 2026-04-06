"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Insert mutation for discussion_thread_watchers.
 * Optimistically adds a row and invalidates the cache on settle.
 */
export function useDiscussionThreadWatcherInsert() {
  const { courseId, userId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "discussion_thread_watchers",
    queryKey: ["course", courseId, "discussion_thread_watchers", userId],
    mutationType: "insert",
    supabase
  });
}

/**
 * Update mutation for discussion_thread_watchers.
 */
export function useDiscussionThreadWatcherUpdate() {
  const { courseId, userId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "discussion_thread_watchers",
    queryKey: ["course", courseId, "discussion_thread_watchers", userId],
    mutationType: "update",
    supabase
  });
}
