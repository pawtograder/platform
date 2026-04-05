import type { QueryClient } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiffOperation = {
  type: "upsert" | "remove";
  rows: Record<string, unknown>[];
};

export type CacheDiff = {
  queryKey: readonly unknown[];
  operations: DiffOperation[];
  source: string; // tabId that originated the diff
  timestamp: number;
};

// ---------------------------------------------------------------------------
// RealtimeDiffChannel
// ---------------------------------------------------------------------------

const DEFAULT_CHANNEL = "pawtograder-rt-diffs";

/**
 * Broadcasts TanStack Query cache diffs between browser tabs via
 * `BroadcastChannel` so only the leader tab needs a WebSocket connection.
 *
 * SSR-safe: if `BroadcastChannel` is unavailable (e.g. during SSR), all
 * methods degrade to no-ops.
 */
export class RealtimeDiffChannel {
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<(diff: CacheDiff) => void>();
  private tabId: string;

  constructor(tabId: string, options?: { channelName?: string }) {
    this.tabId = tabId;

    if (typeof BroadcastChannel === "undefined") return;

    this.channel = new BroadcastChannel(options?.channelName ?? DEFAULT_CHANNEL);

    this.channel.onmessage = (event: MessageEvent<CacheDiff>) => {
      const diff = event.data;
      // Echo prevention — ignore diffs originating from this tab
      if (diff.source === this.tabId) return;
      for (const cb of this.listeners) {
        cb(diff);
      }
    };
  }

  /** Broadcast a diff to other tabs. No-op during SSR. */
  broadcastDiff(diff: CacheDiff): void {
    this.channel?.postMessage(diff);
  }

  /**
   * Subscribe to incoming diffs from other tabs.
   * Returns an unsubscribe function.
   */
  onDiff(callback: (diff: CacheDiff) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /** Tear down the underlying BroadcastChannel and remove all listeners. */
  close(): void {
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
  }

  // -----------------------------------------------------------------------
  // Static utility
  // -----------------------------------------------------------------------

  /**
   * Pure helper that applies a `CacheDiff` to a TanStack `QueryClient`.
   *
   * - **upsert**: merges rows into the cached array by `id`, preserving
   *   order — existing items are updated in place, new items are appended.
   * - **remove**: filters rows out of the cached array by `id`.
   *
   * If the cached data is not an array the operation is skipped gracefully.
   * If the cache is empty/undefined an upsert sets the rows as initial data.
   */
  static applyDiff(queryClient: QueryClient, diff: CacheDiff): void {
    for (const op of diff.operations) {
      const existing = queryClient.getQueryData<unknown>(diff.queryKey);

      if (op.type === "upsert") {
        if (existing === undefined || existing === null) {
          // No cached data yet — seed with the incoming rows
          queryClient.setQueryData(diff.queryKey, [...op.rows]);
          continue;
        }

        if (!Array.isArray(existing)) continue; // skip non-array caches

        const incoming = new Map<unknown, Record<string, unknown>>(op.rows.map((r) => [r.id, r]));

        // Update existing items in place, track which incoming rows matched
        const merged = existing.map((item: Record<string, unknown>) => {
          const replacement = incoming.get(item.id);
          if (replacement) {
            incoming.delete(item.id);
            return replacement;
          }
          return item;
        });

        // Append any genuinely new rows at the end
        for (const newRow of incoming.values()) {
          merged.push(newRow);
        }

        queryClient.setQueryData(diff.queryKey, merged);
      } else if (op.type === "remove") {
        if (!Array.isArray(existing)) continue;

        const idsToRemove = new Set(op.rows.map((r) => r.id));
        const filtered = existing.filter((item: Record<string, unknown>) => !idsToRemove.has(item.id));
        queryClient.setQueryData(diff.queryKey, filtered);
      }
    }
  }
}
