"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type LivePoll = Database["public"]["Tables"]["live_polls"]["Row"];

/**
 * Fetches live polls for the current course with cross-tab realtime sync.
 * Ordered by created_at descending (newest first).
 * Replaces: CourseController.livePolls
 */
export function useLivePollsQuery() {
  const { courseId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"live_polls", LivePoll>({
    queryKey: ["course", courseId, "live_polls"],
    table: "live_polls",
    queryFn: () =>
      supabase.from("live_polls").select("*").eq("class_id", courseId).order("created_at", { ascending: false }),
    classRtc,
    supabase,
    scope: "class",
    realtimeFilter: (row) => (row as Record<string, unknown>).class_id === courseId
  });
}
