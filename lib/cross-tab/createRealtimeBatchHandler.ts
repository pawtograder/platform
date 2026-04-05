/**
 * Pure function that processes a batch of realtime broadcast messages into
 * TanStack Query cache operations and produces a CacheDiff for cross-tab sync.
 *
 * This is the extracted, testable core of what TableController._processBatchedOperations
 * does — separated from React and class state so it can be unit-tested in isolation.
 */

import { QueryClient } from "@tanstack/react-query";
import type { CacheDiff, DiffOperation } from "./RealtimeDiffChannel";
import type { BroadcastMessage } from "@/lib/TableController";

export type BatchHandlerConfig = {
  table: string;
  queryKey: readonly unknown[];
  queryClient: QueryClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any; // SupabaseClient — using any to avoid complex generics
  selectForRefetch?: string;
  realtimeFilter?: (row: Record<string, unknown>) => boolean;
  tabId: string;
};

export type BatchResult = {
  cacheDiff: CacheDiff | null;
  updatedRows: Record<string, unknown>[];
  removedIds: (number | string)[];
};

/**
 * Process a batch of broadcast messages, apply them to the TanStack Query cache,
 * and return a CacheDiff suitable for broadcasting to follower tabs.
 */
export async function processRealtimeBatch(
  messages: BroadcastMessage[],
  config: BatchHandlerConfig
): Promise<BatchResult> {
  const { table, queryKey, queryClient, supabase, selectForRefetch, realtimeFilter, tabId } = config;

  // -----------------------------------------------------------------------
  // 1. Classify messages by operation & data availability
  // -----------------------------------------------------------------------

  const inlineInserts: Record<string, unknown>[] = [];
  const inlineUpdates: Record<string, unknown>[] = [];
  const idsToRefetchInsert: (number | string)[] = [];
  const idsToRefetchUpdate: (number | string)[] = [];
  const idsToDelete: (number | string)[] = [];

  for (const msg of messages) {
    // Skip non-table-change messages and messages for other tables
    if (msg.type !== "table_change" && msg.type !== "staff_data_change") continue;
    if (msg.table && msg.table !== table) continue;
    if (!msg.operation || msg.operation === "BULK_UPDATE") continue;

    switch (msg.operation) {
      case "DELETE":
        if (msg.data && (msg.data as Record<string, unknown>).id != null) {
          idsToDelete.push((msg.data as Record<string, unknown>).id as number | string);
        } else if (msg.row_id != null) {
          idsToDelete.push(msg.row_id);
        }
        break;

      case "INSERT":
        if (msg.data) {
          inlineInserts.push(msg.data as Record<string, unknown>);
        } else if (msg.row_id != null) {
          idsToRefetchInsert.push(msg.row_id);
        }
        break;

      case "UPDATE":
        if (msg.data) {
          inlineUpdates.push(msg.data as Record<string, unknown>);
        } else if (msg.row_id != null) {
          idsToRefetchUpdate.push(msg.row_id);
        }
        break;
    }
  }

  // -----------------------------------------------------------------------
  // 2. Batch-refetch ID-only messages
  // -----------------------------------------------------------------------

  const allIdsToRefetch = [...idsToRefetchInsert, ...idsToRefetchUpdate];
  const refetchedById = new Map<number | string, Record<string, unknown>>();

  if (allIdsToRefetch.length > 0) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select(selectForRefetch ?? "*")
        .in("id", allIdsToRefetch);

      if (!error && data) {
        for (const row of data as Record<string, unknown>[]) {
          refetchedById.set(row.id as number | string, row);
        }
      }
    } catch {
      // Swallow — refetch failure means we skip those rows
    }
  }

  // Merge refetched rows into their respective operation arrays
  for (const id of idsToRefetchInsert) {
    const row = refetchedById.get(id);
    if (row) inlineInserts.push(row);
  }
  for (const id of idsToRefetchUpdate) {
    const row = refetchedById.get(id);
    if (row) inlineUpdates.push(row);
  }

  // -----------------------------------------------------------------------
  // 3. Apply realtimeFilter
  // -----------------------------------------------------------------------

  const acceptedInserts = realtimeFilter ? inlineInserts.filter((row) => realtimeFilter(row)) : inlineInserts;

  const acceptedUpdates = realtimeFilter ? inlineUpdates.filter((row) => realtimeFilter(row)) : inlineUpdates;

  // -----------------------------------------------------------------------
  // 4. Apply to QueryClient cache
  // -----------------------------------------------------------------------

  const upsertRows = [...acceptedInserts, ...acceptedUpdates];
  const removedIds = [...idsToDelete];

  if (upsertRows.length > 0 || removedIds.length > 0) {
    queryClient.setQueryData<unknown>(queryKey, (existing: unknown) => {
      let rows: Record<string, unknown>[] = Array.isArray(existing) ? [...existing] : [];

      // Upsert: update in place or append
      if (upsertRows.length > 0) {
        const incoming = new Map<unknown, Record<string, unknown>>(upsertRows.map((r) => [r.id, r]));

        rows = rows.map((item) => {
          const replacement = incoming.get(item.id);
          if (replacement) {
            incoming.delete(item.id);
            return replacement;
          }
          return item;
        });

        // Append genuinely new rows
        for (const newRow of incoming.values()) {
          rows.push(newRow);
        }
      }

      // Remove deleted rows
      if (removedIds.length > 0) {
        const removeSet = new Set<unknown>(removedIds);
        rows = rows.filter((item) => !removeSet.has(item.id));
      }

      return rows;
    });
  }

  // -----------------------------------------------------------------------
  // 5. Build CacheDiff for cross-tab broadcast
  // -----------------------------------------------------------------------

  const operations: DiffOperation[] = [];

  if (upsertRows.length > 0) {
    operations.push({ type: "upsert", rows: upsertRows });
  }
  if (removedIds.length > 0) {
    operations.push({
      type: "remove",
      rows: removedIds.map((id) => ({ id }))
    });
  }

  const cacheDiff: CacheDiff | null =
    operations.length > 0 ? { queryKey, operations, source: tabId, timestamp: Date.now() } : null;

  return {
    cacheDiff,
    updatedRows: upsertRows,
    removedIds
  };
}
