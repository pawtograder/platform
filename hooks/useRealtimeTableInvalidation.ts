"use client";

import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLeaderContext } from "@/lib/cross-tab/LeaderProvider";
import type { PawtograderRealTimeController } from "@/lib/PawtograderRealTimeController";

/**
 * Leader-aware hook that invalidates a TanStack Query cache entry whenever
 * any of the specified related tables receive a realtime broadcast.
 *
 * Use this for cross-table invalidation: e.g. a joined query on
 * `review_assignments` that also depends on `submission_reviews` and
 * `review_assignment_rubric_parts`.
 *
 * Only the leader tab subscribes to the realtime controller; follower tabs
 * receive the invalidation through TanStack Query's built-in stale/refetch
 * mechanics once the leader tab's cache is updated.
 */
export function useRealtimeTableInvalidation({
  tables,
  queryKey,
  classRtc,
  debounceMs = 1000,
  enabled = true
}: {
  /** Tables to listen for realtime changes on */
  tables: string[];
  /** Query key to invalidate when any of the tables change */
  queryKey: readonly unknown[];
  /** Realtime controller to subscribe to */
  classRtc: PawtograderRealTimeController | null;
  /** Debounce interval in ms (default 1000) */
  debounceMs?: number;
  /** Whether the hook is active */
  enabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const { leader } = useLeaderContext();
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedInvalidate = useCallback(() => {
    if (debounceTimerRef.current) return;
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void queryClient.invalidateQueries({ queryKey: queryKeyRef.current });
    }, debounceMs);
  }, [queryClient, debounceMs]);

  useEffect(() => {
    if (!enabled || !classRtc) return;

    const isLeader = leader?.isLeader ?? false;
    if (!isLeader) return;

    const cleanups: (() => void)[] = [];

    for (const table of tables) {
      const unsub = classRtc.subscribeToTable(table, () => {
        debouncedInvalidate();
      });
      cleanups.push(unsub);
    }

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      for (const unsub of cleanups) {
        unsub();
      }
    };
    // Stable deps: leader identity and table list don't change often
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, classRtc, leader?.isLeader, debouncedInvalidate, JSON.stringify(tables)]);
}
