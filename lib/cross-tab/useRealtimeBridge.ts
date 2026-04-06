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
import type { BroadcastMessage } from "@/lib/BroadcastMessageTypes";

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
  /** Submission ID for scoped channel awareness — tells the batch handler which submission this bridge is for. */
  submissionId?: number;
  /** Additional realtime controllers to subscribe to (e.g. office hours RT controller). */
  additionalRealTimeControllers?: PawtograderRealTimeController[];
  /**
   * Column for incremental catch-up (`.gt` / `.order`) and watermark extraction.
   * Default `updated_at`. Use another column (e.g. `created_at`) when the table has no `updated_at`.
   */
  timestampColumn?: string;
  /**
   * When a row has no usable value on `timestampColumn`, try this column for watermark / seeding only.
   * The catch-up query still uses `timestampColumn` only.
   */
  timestampColumnFallback?: string;

  leader: TabLeaderElection | null;
  diffChannel: RealtimeDiffChannel | null;
};

const DEFAULT_DEBOUNCE_MS = 500;
const MAX_BUFFER_SIZE = 50;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRealtimeBridge(config: RealtimeBridgeConfig): void {
  const { table, classRtc, scope, enabled = true, leader, diffChannel } = config;

  const queryClient = useQueryClient();

  // -----------------------------------------------------------------------
  // Refs — mutable state that persists across renders without causing them.
  // configRef holds the latest config so callbacks never close over stale
  // references (queryKey, realtimeFilter, etc. may be new every render).
  // -----------------------------------------------------------------------

  const bufferRef = useRef<BroadcastMessage[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxUpdatedAtRef = useRef<number | null>(null);
  const processingRef = useRef(false);

  const configRef = useRef(config);
  configRef.current = config;

  // Stable serialized queryKey for the main effect dep array — avoids
  // tearing down subscriptions when the caller passes a new array reference
  // with the same content.
  const queryKeyJson = JSON.stringify(config.queryKey);

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
      const cfg = configRef.current;
      const batchConfig: BatchHandlerConfig = {
        table: cfg.table,
        queryKey: cfg.queryKey,
        queryClient,
        supabase: cfg.supabase,
        selectForRefetch: cfg.selectForRefetch,
        realtimeFilter: cfg.realtimeFilter,
        tabId: cfg.leader?.tabId ?? "unknown",
        submissionId: cfg.submissionId
      };

      const result = await processRealtimeBatch(messages, batchConfig);

      // Advance watermark from processed rows
      const tsCol = cfg.timestampColumn ?? "updated_at";
      const tsFallback = cfg.timestampColumnFallback;
      for (const row of result.updatedRows) {
        const ts = extractTimestampMs(row as Record<string, unknown>, tsCol, tsFallback);
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
  // Apply incoming diff from leader tab (follower path).
  // Reads queryKey from configRef to avoid dep-array instability.
  // -----------------------------------------------------------------------

  const applyDiff = useCallback(
    (diff: CacheDiff) => {
      const currentKey = configRef.current.queryKey;
      if (JSON.stringify(diff.queryKey) !== JSON.stringify(currentKey)) return;
      RealtimeDiffChannel.applyDiff(queryClient, diff);

      // Advance our watermark so catch-up on promotion starts from here
      const cfg = configRef.current;
      const tsCol = cfg.timestampColumn ?? "updated_at";
      const tsFallback = cfg.timestampColumnFallback;
      for (const op of diff.operations) {
        if (op.type === "upsert") {
          for (const row of op.rows) {
            const ts = extractTimestampMs(row as Record<string, unknown>, tsCol, tsFallback);
            if (ts != null) {
              maxUpdatedAtRef.current = maxUpdatedAtRef.current == null ? ts : Math.max(maxUpdatedAtRef.current, ts);
            }
          }
        }
      }
    },
    [queryClient]
  );

  // -----------------------------------------------------------------------
  // Incremental catch-up: refetch rows newer than watermark.
  // Reads all config from configRef — zero unstable deps.
  // -----------------------------------------------------------------------

  const catchUp = useCallback(async () => {
    if (maxUpdatedAtRef.current == null) return;

    const cfg = configRef.current;
    if (!cfg.supabase || !cfg.table) return;

    const tsCol = cfg.timestampColumn ?? "updated_at";
    const tsFallback = cfg.timestampColumnFallback;

    try {
      const sinceIso = new Date(maxUpdatedAtRef.current).toISOString();
      const { data, error } = await cfg.supabase
        .from(cfg.table)
        .select(cfg.selectForRefetch ?? "*")
        .gt(tsCol, sinceIso)
        .order(tsCol, { ascending: true });

      if (error) {
        throw error;
      }

      if (data == null) {
        throw new Error("catchUp: Supabase returned no data");
      }

      if ((data as unknown[]).length === 0) {
        return;
      }

      const rows = data as Record<string, unknown>[];
      const accepted = cfg.realtimeFilter ? rows.filter((r: Record<string, unknown>) => cfg.realtimeFilter!(r)) : rows;

      if (accepted.length === 0) return;

      // Apply to cache
      queryClient.setQueryData<unknown>(cfg.queryKey, (existing: unknown) => {
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
        const ts = extractTimestampMs(row, tsCol, tsFallback);
        if (ts != null) {
          maxUpdatedAtRef.current = maxUpdatedAtRef.current == null ? ts : Math.max(maxUpdatedAtRef.current, ts);
        }
      }

      // Broadcast diff so followers get the catch-up data
      if (cfg.diffChannel) {
        cfg.diffChannel.broadcastDiff({
          queryKey: cfg.queryKey,
          operations: [{ type: "upsert", rows: accepted }],
          source: cfg.leader?.tabId ?? "unknown",
          timestamp: Date.now()
        });
      }
    } catch (err) {
      console.error("[useRealtimeBridge] catchUp failed", {
        table: cfg.table,
        queryKey: cfg.queryKey,
        timestampColumn: tsCol,
        err
      });
    }
  }, [queryClient]);

  // -----------------------------------------------------------------------
  // Main effect: wire up subscriptions based on role and scope.
  // Uses queryKeyJson (serialized) instead of queryKey (array ref) to
  // prevent teardown/re-subscribe on every render.
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!enabled || !classRtc) return;

    const cleanups: (() => void)[] = [];

    // Seed watermark from existing cached data so that a newly promoted
    // follower can do an incremental catch-up instead of returning early.
    if (maxUpdatedAtRef.current == null) {
      const cfgSeed = configRef.current;
      const tsColSeed = cfgSeed.timestampColumn ?? "updated_at";
      const tsFallbackSeed = cfgSeed.timestampColumnFallback;
      const currentKey = cfgSeed.queryKey;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cached = queryClient.getQueryData<any[]>(currentKey);
      if (Array.isArray(cached)) {
        for (const row of cached) {
          const ts = extractTimestampMs(row as Record<string, unknown>, tsColSeed, tsFallbackSeed);
          if (ts != null) {
            maxUpdatedAtRef.current = maxUpdatedAtRef.current == null ? ts : Math.max(maxUpdatedAtRef.current, ts);
          }
        }
      }
    }

    const isLeader = leader?.isLeader ?? false;
    const shouldSubscribeRtc = scope === "scoped" || isLeader;

    if (shouldSubscribeRtc) {
      const unsub = classRtc.subscribeToTable(table, enqueue);
      cleanups.push(unsub);

      // Also subscribe to any additional RT controllers (e.g. office hours)
      if (configRef.current.additionalRealTimeControllers) {
        for (const rtc of configRef.current.additionalRealTimeControllers) {
          const additionalUnsub = rtc.subscribeToTable(table, enqueue);
          cleanups.push(additionalUnsub);
        }
      }
    }

    if (scope === "class" && !isLeader && diffChannel) {
      const unsub = diffChannel.onDiff(applyDiff);
      cleanups.push(unsub);
    }

    if (leader && scope === "class") {
      let rtcUnsub: (() => void) | null = null;
      let diffUnsub: (() => void) | null = null;

      const unsub = leader.onLeaderChange((nowLeader: boolean) => {
        rtcUnsub?.();
        rtcUnsub = null;
        diffUnsub?.();
        diffUnsub = null;

        if (nowLeader && classRtc) {
          rtcUnsub = classRtc.subscribeToTable(table, enqueue);
          void catchUp();
        } else if (!nowLeader && diffChannel) {
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
      if (debounceTimerRef.current != null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      bufferRef.current = [];

      for (const cleanup of cleanups) {
        cleanup();
      }
    };
    // queryKeyJson is a stable serialization of queryKey — avoids effect
    // churn from new array references with identical content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, classRtc, leader, diffChannel, scope, table, enqueue, applyDiff, catchUp, queryKeyJson]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTimestampValue(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function extractTimestampMs(
  row: Record<string, unknown>,
  timestampColumn: string,
  timestampColumnFallback?: string
): number | null {
  const primary = parseTimestampValue(row[timestampColumn]);
  if (primary != null) return primary;
  if (timestampColumnFallback && timestampColumnFallback !== timestampColumn) {
    return parseTimestampValue(row[timestampColumnFallback]);
  }
  return null;
}
