"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type DiscussionThreadReadStatus = Database["public"]["Tables"]["discussion_thread_read_status"]["Row"];

/**
 * Fetches and subscribes to discussion thread read status for the current user.
 * User-scoped by user_id — no SSR initialData.
 */
export function useDiscussionThreadReadStatusQuery() {
  const { courseId, userId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"discussion_thread_read_status", DiscussionThreadReadStatus>({
    queryKey: ["course", courseId, "discussion_thread_read_status", userId],
    table: "discussion_thread_read_status",
    queryFn: () => supabase.from("discussion_thread_read_status").select("*").eq("user_id", userId),
    classRtc,
    supabase,
    scope: "class"
  });
}
