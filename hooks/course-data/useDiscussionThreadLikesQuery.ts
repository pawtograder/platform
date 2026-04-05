"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type DiscussionThreadLike = Database["public"]["Tables"]["discussion_thread_likes"]["Row"];

/**
 * Fetches and subscribes to discussion thread likes created by the current user.
 * Scoped by profileId (creator) with realtime filter.
 * Disabled when profileId is null (profile not yet loaded).
 */
export function useDiscussionThreadLikesQuery() {
  const { courseId, profileId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"discussion_thread_likes", DiscussionThreadLike>({
    queryKey: ["course", courseId, "discussion_thread_likes", profileId],
    table: "discussion_thread_likes",
    queryFn: () => supabase.from("discussion_thread_likes").select("*").eq("creator", profileId!),
    realtimeFilter: (row: Record<string, unknown>) => row.creator === profileId,
    classRtc,
    supabase,
    scope: "class",
    enabled: !!profileId
  });
}
