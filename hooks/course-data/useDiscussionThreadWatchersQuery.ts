"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type DiscussionThreadWatcher = Database["public"]["Tables"]["discussion_thread_watchers"]["Row"];

/**
 * Fetches and subscribes to discussion thread watchers for the current user in the current course.
 * User-scoped by user_id + class_id with realtime filter — no SSR initialData.
 */
export function useDiscussionThreadWatchersQuery() {
  const { courseId, userId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"discussion_thread_watchers", DiscussionThreadWatcher>({
    queryKey: ["course", courseId, "discussion_thread_watchers", userId],
    table: "discussion_thread_watchers",
    queryFn: () =>
      supabase.from("discussion_thread_watchers").select("*").eq("user_id", userId).eq("class_id", courseId),
    realtimeFilter: (row: Record<string, unknown>) => row.user_id === userId && row.class_id === courseId,
    classRtc,
    supabase,
    scope: "class"
  });
}
