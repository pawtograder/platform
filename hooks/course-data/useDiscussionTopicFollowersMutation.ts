"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Insert mutation for discussion_topic_followers.
 * Optimistically adds a row and invalidates the cache on settle.
 */
export function useDiscussionTopicFollowerInsert() {
  const { courseId, userId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "discussion_topic_followers",
    queryKey: ["course", courseId, "discussion_topic_followers", userId],
    mutationType: "insert",
    supabase
  });
}

/**
 * Update mutation for discussion_topic_followers.
 */
export function useDiscussionTopicFollowerUpdate() {
  const { courseId, userId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "discussion_topic_followers",
    queryKey: ["course", courseId, "discussion_topic_followers", userId],
    mutationType: "update",
    supabase
  });
}

/**
 * Delete mutation for discussion_topic_followers.
 * Performs a hard DELETE (not soft delete).
 */
export function useDiscussionTopicFollowerDelete() {
  const { courseId, userId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "discussion_topic_followers",
    queryKey: ["course", courseId, "discussion_topic_followers", userId],
    mutationType: "delete",
    supabase
  });
}
