"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { DiscussionTopic } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches and subscribes to discussion_topics for the current course.
 * Receives SSR initialData when available.
 */
export function useDiscussionTopicsQuery() {
  const { courseId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"discussion_topics", DiscussionTopic>({
    queryKey: ["course", courseId, "discussion_topics"],
    table: "discussion_topics",
    queryFn: () => supabase.from("discussion_topics").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).class_id === courseId
  });
}
