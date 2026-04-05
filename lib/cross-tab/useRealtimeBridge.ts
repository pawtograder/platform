/**
 * React hook that bridges Supabase Realtime → TanStack Query cache, with
 * cross-tab synchronisation via leader election and BroadcastChannel diffs.
 *
 * Leader tab:  subscribes to classRtc, processes batches, broadcasts diffs.
 * Follower tab: listens to diff channel and applies diffs locally.
 *
 * For "scoped" subscriptions (e.g. per-submission channels), every tab
 * subscribes directly — scoped channels are cheap and per-entity.
 */

import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TabLeaderElection } from "./TabLeaderElection";
import { RealtimeDiffChannel, CacheDiff } from "./RealtimeDiffChannel";
import { processRealtimeBatch, BatchHandlerConfig } from "./createRealtimeBatchHandler";
import type { PawtograderRealTimeController } from "@/lib/PawtograderRealTimeController";
import type { BroadcastMessage } from "@/lib/TableController";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type RealtimeBridgeConfig = {
  table: string;
  queryKey: readonly unknown[];
  classRtc: PawtograderRealTimeController | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  realtimeFilter?: (row: Record<string, unknown>) => boolean;
  selectForRefetch?: string;
  debounceMs?: number; // default 500
  scope: "class" | "scoped";
  enabled?: boolean; // default true

  // Until Phase 1d wires up the LeaderProvider context, accept these directly.
  leader: TabLeaderElection | null;
  diffChannel: RealtimeDiffChannel | null;
};

const DEFAULT_DEBOUNCE_MS = 500;
const MAX_BUFFER_SIZE = 50;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRealtimeBridge(config: RealtimeBridgeConfig): void {
  const {
    table,
    queryKey,
    classRtc,
    supabase,
    realtimeFilter,
    selectForRefetch,
    scope,
    enabled = true,
    leader,
    diffChannel
  } = config;

  const queryClient = useQueryClient();

  // -----------------------------------------------------------------------
  // Refs — mutable state that persists across renders without causing them
  // -----------------------------------------------------------------------

  const bufferRef = useRef<BroadcastMessage[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxUpdatedAtRef = useRef<number | null>(null);
  // Track whether we're currently processing to prevent overlapping flushes
  const processingRef = useRef(false);

  // Stable reference to the latest config for use inside callbacks
  const configRef = useRef(config);
  configRef.current = config;

  // -----------------------------------------------------------------------
  // Flush: process buffered messages and broadcast diff
  // -----------------------------------------------------------------------

  const flush = useCallback(async () => {
    if (bufferRef.current.length === 0) return;
    if (processingRef.current) return;

    processingRef.current = true;
    const messages = bufferRef.current;
    bufferRef.current = [];

    try {
      const batchConfig: BatchHandlerConfig = {
        table: configRef.current.table,
        queryKey: configRef.current.queryKey,
        queryClient,
        supabase: configRef.current.supabase,
        selectForRefetch: configRef.current.selectForRefetch,
        realtimeFilter: configRef.current.realtimeFilter,
        tabId: configRef.current.leader?.tabId ?? "unknown"
      };

      const result = await processRealtimeBatch(messages, batchConfig);

      // Advance watermark from processed rows
      for (const row of result.updatedRows) {
        const ts = extractUpdatedAtMs(row);
        if (ts != null) {
          maxUpdatedAtRef.current = maxUpdatedAtRef.current == null ? ts : Math.max(maxUpdatedAtRef.current, ts);
        }
      }

      // Broadcast diff to follower tabs
      if (result.cacheDiff && configRef.current.diffChannel) {
        configRef.current.diffChannel.broadcastDiff(result.cacheDiff);
      }
    } finally {
      processingRef.current = false;

      // If more messages arrived during processing, schedule another flush
      if (bufferRef.current.length > 0) {
        scheduleFlush();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);

  // -----------------------------------------------------------------------
  // Schedule flush with debounce
  // -----------------------------------------------------------------------

  const scheduleFlush = useCallback(() => {
    if (debounceTimerRef.current != null) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      flush();
    }, configRef.current.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }, [flush]);

  // -----------------------------------------------------------------------
  // Enqueue a broadcast message
  // -----------------------------------------------------------------------

  const enqueue = useCallback(
    (message: BroadcastMessage) => {
      bufferRef.current.push(message);

      // Flush immediately if buffer is large to prevent unbounded growth
      if (bufferRef.current.length >= MAX_BUFFER_SIZE) {
        if (debounceTimerRef.current != null) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        flush();
      } else {
        scheduleFlush();
      }
    },
    [flush, scheduleFlush]
  );

  // -----------------------------------------------------------------------
  // Apply incoming diff from leader tab (follower path)
  // -----------------------------------------------------------------------

  const applyDiff = useCallback(
    (diff: CacheDiff) => {
      // Only apply diffs that match our queryKey
      if (JSON.stringify(diff.queryKey) !== JSON.stringify(queryKey)) return;
      RealtimeDiffChannel.applyDiff(queryClient, diff);

      // Advance our watermark so catch-up on promotion starts from here
      for (const op of diff.operations) {
        if (op.type === "upsert") {
          for (const row of op.rows) {
            const ts = extractUpdatedAtMs(row);
            if (ts != null) {
              maxUpdatedAtRef.current = maxUpdatedAtRef.current == null ? ts : Math.max(maxUpdatedAtRef.current, ts);
            }
          }
        }
      }
    },
    [queryClient, queryKey]
  );

  // -----------------------------------------------------------------------
  // Incremental catch-up: refetch rows newer than watermark
  // -----------------------------------------------------------------------

  const catchUp = useCallback(async () => {
    if (maxUpdatedAtRef.current == null) return;
    if (!supabase || !table) return;

    try {
      const sinceIso = new Date(maxUpdatedAtRef.current).toISOString();
      const { data, error } = await supabase
        .from(table)
        .select(selectForRefetch ?? "*")
        .gt("updated_at", sinceIso)
        .order("updated_at", { ascending: true });

      if (error || !data || (data as unknown[]).length === 0) return;

      const rows = data as Record<string, unknown>[];
      const accepted = realtimeFilter ? rows.filter((r) => realtimeFilter(r)) : rows;

      if (accepted.length === 0) return;

      // Apply to cache
      queryClient.setQueryData<unknown>(queryKey, (existing: unknown) => {
        const current: Record<string, unknown>[] = Array.isArray(existing) ? [...existing] : [];
        const incoming = new Map<unknown, Record<string, unknown>>(accepted.map((r) => [r.id, r]));

        const merged = current.map((item) => {
          const replacement = incoming.get(item.id);
          if (replacement) {
            incoming.delete(item.id);
            return replacement;
          }
          return item;
        });

        for (const newRow of incoming.values()) {
          merged.push(newRow);
        }

        return merged;
      });

      // Advance watermark
      for (const row of accepted) {
        const ts = extractUpdatedAtMs(row);
        if (ts != null) {
          maxUpdatedAtRef.current = maxUpdatedAtRef.current == null ? ts : Math.max(maxUpdatedAtRef.current, ts);
        }
      }

      // Broadcast diff so followers get the catch-up data
      if (diffChannel) {
        diffChannel.broadcastDiff({
          queryKey,
          operations: [{ type: "upsert", rows: accepted }],
          source: leader?.tabId ?? "unknown",
          timestamp: Date.now()
        });
      }
    } catch {
      // Catch-up failure is non-fatal; next realtime event will trigger another attempt
    }
  }, [supabase, table, selectForRefetch, realtimeFilter, queryClient, queryKey, diffChannel, leader]);

  // -----------------------------------------------------------------------
  // Main effect: wire up subscriptions based on role and scope
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!enabled || !classRtc) return;

    const cleanups: (() => void)[] = [];

    const isLeader = leader?.isLeader ?? false;
    const shouldSubscribeRtc = scope === "scoped" || isLeader;

    // Subscribe to classRtc if we should
    if (shouldSubscribeRtc) {
      const unsub = classRtc.subscribeToTable(table, enqueue);
      cleanups.push(unsub);
    }

    // Follower for class-scope: listen to diff channel instead
    if (scope === "class" && !isLeader && diffChannel) {
      const unsub = diffChannel.onDiff(applyDiff);
      cleanups.push(unsub);
    }

    // For scoped mode, non-leaders also broadcast diffs for sibling tabs
    // (handled automatically — processRealtimeBatch always produces a diff)

    // Leader change handler
    if (leader && scope === "class") {
      let rtcUnsub: (() => void) | null = null;
      let diffUnsub: (() => void) | null = null;

      const unsub = leader.onLeaderChange((nowLeader: boolean) => {
        // Clean up previous subscriptions for this change handler
        rtcUnsub?.();
        rtcUnsub = null;
        diffUnsub?.();
        diffUnsub = null;

        if (nowLeader && classRtc) {
          // Promoted to leader: subscribe to classRtc, catch up
          rtcUnsub = classRtc.subscribeToTable(table, enqueue);
          catchUp();
        } else if (!nowLeader && diffChannel) {
          // Demoted: listen to diff channel
          diffUnsub = diffChannel.onDiff(applyDiff);
        }
      });

      cleanups.push(() => {
        unsub();
        rtcUnsub?.();
        diffUnsub?.();
      });
    }

    return () => {
      // Clear pending debounce
      if (debounceTimerRef.current != null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      // Flush any remaining buffered messages synchronously isn't possible
      // (processRealtimeBatch is async), so we just discard.
      bufferRef.current = [];

      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [enabled, classRtc, leader, diffChannel, scope, table, enqueue, applyDiff, catchUp]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract updated_at from a row-like object as epoch ms; returns null if absent/unparsable. */
function extractUpdatedAtMs(row: Record<string, unknown>): number | null {
  const value = row.updated_at;
  if (!value) return null;
  if (typeof value === "string") {
    const t = new Date(value).getTime();
    return isNaN(t) ? null : t;
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return isNaN(t) ? null : t;
  }
  return null;
}
