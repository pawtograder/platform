"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useDiscussionDataContext } from "./useDiscussionDataContext";
import type { DiscussionThread } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches all threads in a discussion tree (root + descendants) with scoped
 * per-thread realtime updates.
 * Replaces: DiscussionThreadsController.tableController + useTableControllerTableValues()
 */
export function useDiscussionThreadQuery() {
  const { rootThreadId, courseId, supabase, classRtc } = useDiscussionDataContext();

  return useSupabaseRealtimeQuery<"discussion_threads", DiscussionThread>({
    queryKey: ["course", courseId, "discussion_thread", rootThreadId],
    table: "discussion_threads",
    queryFn: () => supabase.from("discussion_threads").select("*").or(`id.eq.${rootThreadId},root.eq.${rootThreadId}`),
    classRtc,
    supabase,
    scope: "scoped",
    realtimeFilter: (row) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = row as any;
      return r.id === rootThreadId || r.root === rootThreadId;
    }
  });
}
