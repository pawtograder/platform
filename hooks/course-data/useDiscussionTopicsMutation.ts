"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Insert mutation for discussion_topics.
 * Optimistically adds a row and invalidates the cache on settle.
 */
export function useDiscussionTopicInsert() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "discussion_topics",
    queryKey: ["course", courseId, "discussion_topics"],
    mutationType: "insert",
    supabase
  });
}

/**
 * Update mutation for discussion_topics.
 */
export function useDiscussionTopicUpdate() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "discussion_topics",
    queryKey: ["course", courseId, "discussion_topics"],
    mutationType: "update",
    supabase
  });
}

/**
 * Delete mutation for discussion_topics.
 * Performs a hard DELETE (not soft delete).
 */
export function useDiscussionTopicDelete() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "discussion_topics",
    queryKey: ["course", courseId, "discussion_topics"],
    mutationType: "delete",
    supabase
  });
}
