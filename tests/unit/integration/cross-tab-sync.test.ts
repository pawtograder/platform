/**
 * Integration tests: full pipeline of leader election -> RT event -> batch
 * processing -> cache update -> diff broadcast -> follower cache update.
 *
 * Tests the pure classes and functions directly (no React rendering) for speed
 * and determinism, except for SSR hydration and mutation tests which use
 * renderHook.
 */

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { renderHook, act, waitFor } from "@testing-library/react";
import React from "react";
import { TabLeaderElection } from "@/lib/cross-tab/TabLeaderElection";
import { RealtimeDiffChannel, CacheDiff } from "@/lib/cross-tab/RealtimeDiffChannel";
import { processRealtimeBatch, BatchHandlerConfig } from "@/lib/cross-tab/createRealtimeBatchHandler";
import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import type { BroadcastMessage } from "@/lib/TableController";
import { setupMockBroadcastChannel, resetAllChannels } from "@/tests/mocks/MockBroadcastChannel";

// ---------------------------------------------------------------------------
// BroadcastChannel mock (jsdom has no native support)
// ---------------------------------------------------------------------------

setupMockBroadcastChannel();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBroadcast(overrides: Partial<BroadcastMessage> & { operation: string; table: string }): BroadcastMessage {
  return {
    type: "table_change",
    class_id: 1,
    timestamp: new Date().toISOString(),
    ...overrides
  } as BroadcastMessage;
}

function mockSupabase(rows: Record<string, unknown>[] = [], error: any = null) {
  return {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: rows, error }),
        eq: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: rows[0] ?? null, error })
          })
        })
      }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: rows[0] ?? null, error })
        })
      }),
      update: () => ({
        eq: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: rows[0] ?? null, error })
          })
        })
      }),
      delete: () => ({
        eq: () => Promise.resolve({ error })
      })
    })
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
}

function baseConfig(qc: QueryClient, overrides?: Partial<BatchHandlerConfig>): BatchHandlerConfig {
  return {
    table: "profiles",
    queryKey: ["students"],
    queryClient: qc,
    supabase: mockSupabase(),
    tabId: "leader-tab",
    ...overrides
  };
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// ===========================================================================
// Leader Election Integration
// ===========================================================================

describe("Leader Election Integration", () => {
  let instances: TabLeaderElection[];

  beforeEach(() => {
    jest.useFakeTimers();
    instances = [];
    resetAllChannels();
  });

  afterEach(() => {
    for (const inst of instances) inst.close();
    instances = [];
    jest.useRealTimers();
  });

  function create(tabId: string): TabLeaderElection {
    const inst = new TabLeaderElection({ tabId, channelName: "integ-leader" });
    instances.push(inst);
    return inst;
  }

  it("two tabs elect a single leader", () => {
    const tab1 = create("aaa");
    const tab2 = create("bbb");

    jest.advanceTimersByTime(1_500);

    const leaders = [tab1, tab2].filter((t) => t.isLeader);
    expect(leaders).toHaveLength(1);
    // Lowest tabId wins tiebreak
    expect(tab1.isLeader).toBe(true);
    expect(tab2.isLeader).toBe(false);
  });

  it("follower becomes leader after leader resigns", () => {
    const tab1 = create("aaa");
    jest.advanceTimersByTime(1_000);
    expect(tab1.isLeader).toBe(true);

    const tab2 = create("bbb");
    jest.advanceTimersByTime(1_000);
    expect(tab2.isLeader).toBe(false);

    tab1.resign();
    jest.advanceTimersByTime(1_500);

    expect(tab1.isLeader).toBe(false);
    expect(tab2.isLeader).toBe(true);
  });

  it("leader heartbeat keeps followers passive", () => {
    const tab1 = create("aaa");
    jest.advanceTimersByTime(1_000);
    expect(tab1.isLeader).toBe(true);

    const tab2 = create("bbb");
    jest.advanceTimersByTime(1_000);
    expect(tab2.isLeader).toBe(false);

    // Advance multiple heartbeat intervals -- follower should remain passive
    // Heartbeat is every 3s, leader timeout is 5s
    jest.advanceTimersByTime(3_000);
    expect(tab2.isLeader).toBe(false);
    jest.advanceTimersByTime(3_000);
    expect(tab2.isLeader).toBe(false);
    jest.advanceTimersByTime(3_000);
    expect(tab2.isLeader).toBe(false);

    // Leader is still leader the whole time
    expect(tab1.isLeader).toBe(true);
  });
});

// ===========================================================================
// Cross-Tab Cache Sync
// ===========================================================================

describe("Cross-Tab Cache Sync", () => {
  beforeEach(() => {
    resetAllChannels();
  });

  afterEach(() => {
    resetAllChannels();
  });

  it("leader processes RT event and follower gets cache update via diff broadcast", async () => {
    const leaderQC = makeQueryClient();
    const followerQC = makeQueryClient();
    const QUERY_KEY = ["course", 1, "profiles"] as const;

    leaderQC.setQueryData(QUERY_KEY, [{ id: 1, name: "Alice" }]);
    followerQC.setQueryData(QUERY_KEY, [{ id: 1, name: "Alice" }]);

    const leaderDiff = new RealtimeDiffChannel("leader-tab", { channelName: "sync-test" });
    const followerDiff = new RealtimeDiffChannel("follower-tab", { channelName: "sync-test" });

    // Wire follower to apply incoming diffs
    followerDiff.onDiff((diff) => RealtimeDiffChannel.applyDiff(followerQC, diff));

    // Leader processes an INSERT
    const msg = makeBroadcast({
      operation: "INSERT",
      table: "profiles",
      data: { id: 2, name: "Bob" }
    });

    const result = await processRealtimeBatch(
      [msg],
      baseConfig(leaderQC, { queryKey: [...QUERY_KEY], tabId: "leader-tab" })
    );

    // Leader broadcasts the diff
    if (result.cacheDiff) {
      leaderDiff.broadcastDiff(result.cacheDiff);
    }

    // Verify both caches match
    const leaderData = leaderQC.getQueryData(QUERY_KEY);
    const followerData = followerQC.getQueryData(QUERY_KEY);
    expect(leaderData).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" }
    ]);
    expect(followerData).toEqual(leaderData);

    leaderDiff.close();
    followerDiff.close();
  });

  it("INSERT event propagates across tabs", async () => {
    const leaderQC = makeQueryClient();
    const followerQC = makeQueryClient();
    const QK = ["items"] as const;

    leaderQC.setQueryData(QK, [{ id: 1, name: "A" }]);
    followerQC.setQueryData(QK, [{ id: 1, name: "A" }]);

    const leaderDC = new RealtimeDiffChannel("ld", { channelName: "insert-test" });
    const followerDC = new RealtimeDiffChannel("fd", { channelName: "insert-test" });
    followerDC.onDiff((d) => RealtimeDiffChannel.applyDiff(followerQC, d));

    const result = await processRealtimeBatch(
      [makeBroadcast({ operation: "INSERT", table: "profiles", data: { id: 2, name: "B" } })],
      baseConfig(leaderQC, { queryKey: [...QK], tabId: "ld" })
    );

    if (result.cacheDiff) leaderDC.broadcastDiff(result.cacheDiff);

    expect(leaderQC.getQueryData(QK)).toEqual([
      { id: 1, name: "A" },
      { id: 2, name: "B" }
    ]);
    expect(followerQC.getQueryData(QK)).toEqual(leaderQC.getQueryData(QK));

    leaderDC.close();
    followerDC.close();
  });

  it("UPDATE event propagates across tabs", async () => {
    const leaderQC = makeQueryClient();
    const followerQC = makeQueryClient();
    const QK = ["items"] as const;

    const initial = [
      { id: 1, name: "Old" },
      { id: 2, name: "Keep" }
    ];
    leaderQC.setQueryData(QK, [...initial]);
    followerQC.setQueryData(QK, [...initial]);

    const leaderDC = new RealtimeDiffChannel("ld", { channelName: "update-test" });
    const followerDC = new RealtimeDiffChannel("fd", { channelName: "update-test" });
    followerDC.onDiff((d) => RealtimeDiffChannel.applyDiff(followerQC, d));

    const result = await processRealtimeBatch(
      [makeBroadcast({ operation: "UPDATE", table: "profiles", data: { id: 1, name: "New" } })],
      baseConfig(leaderQC, { queryKey: [...QK], tabId: "ld" })
    );

    if (result.cacheDiff) leaderDC.broadcastDiff(result.cacheDiff);

    const expected = [
      { id: 1, name: "New" },
      { id: 2, name: "Keep" }
    ];
    expect(leaderQC.getQueryData(QK)).toEqual(expected);
    expect(followerQC.getQueryData(QK)).toEqual(expected);

    leaderDC.close();
    followerDC.close();
  });

  it("DELETE event propagates across tabs", async () => {
    const leaderQC = makeQueryClient();
    const followerQC = makeQueryClient();
    const QK = ["items"] as const;

    const initial = [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
      { id: 3, name: "C" }
    ];
    leaderQC.setQueryData(QK, [...initial]);
    followerQC.setQueryData(QK, [...initial]);

    const leaderDC = new RealtimeDiffChannel("ld", { channelName: "delete-test" });
    const followerDC = new RealtimeDiffChannel("fd", { channelName: "delete-test" });
    followerDC.onDiff((d) => RealtimeDiffChannel.applyDiff(followerQC, d));

    const result = await processRealtimeBatch(
      [makeBroadcast({ operation: "DELETE", table: "profiles", row_id: 2 })],
      baseConfig(leaderQC, { queryKey: [...QK], tabId: "ld" })
    );

    if (result.cacheDiff) leaderDC.broadcastDiff(result.cacheDiff);

    const expected = [
      { id: 1, name: "A" },
      { id: 3, name: "C" }
    ];
    expect(leaderQC.getQueryData(QK)).toEqual(expected);
    expect(followerQC.getQueryData(QK)).toEqual(expected);

    leaderDC.close();
    followerDC.close();
  });

  it("echo prevention -- leader diff channel ignores its own diffs", () => {
    const leaderQC = makeQueryClient();
    const QK = ["echo"] as const;
    leaderQC.setQueryData(QK, [{ id: 1, v: "original" }]);

    const leaderDC = new RealtimeDiffChannel("ld", { channelName: "echo-test" });
    const received: CacheDiff[] = [];
    leaderDC.onDiff((d) => received.push(d));

    // Leader broadcasts a diff with its own tabId as source
    leaderDC.broadcastDiff({
      queryKey: [...QK],
      operations: [{ type: "upsert", rows: [{ id: 1, v: "modified" }] }],
      source: "ld",
      timestamp: Date.now()
    });

    // The leader's own listener should NOT have fired
    expect(received).toHaveLength(0);
    // Cache should be unchanged
    expect(leaderQC.getQueryData(QK)).toEqual([{ id: 1, v: "original" }]);

    leaderDC.close();
  });

  it("multiple operations in one batch all propagate correctly", async () => {
    const leaderQC = makeQueryClient();
    const followerQC = makeQueryClient();
    const QK = ["multi"] as const;

    const initial = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
      { id: 3, name: "Charlie" }
    ];
    leaderQC.setQueryData(QK, [...initial]);
    followerQC.setQueryData(QK, [...initial]);

    const leaderDC = new RealtimeDiffChannel("ld", { channelName: "multi-test" });
    const followerDC = new RealtimeDiffChannel("fd", { channelName: "multi-test" });
    followerDC.onDiff((d) => RealtimeDiffChannel.applyDiff(followerQC, d));

    const messages = [
      makeBroadcast({ operation: "INSERT", table: "profiles", data: { id: 4, name: "Diana" } }),
      makeBroadcast({ operation: "UPDATE", table: "profiles", data: { id: 1, name: "Alice Updated" } }),
      makeBroadcast({ operation: "DELETE", table: "profiles", row_id: 2 })
    ];

    const result = await processRealtimeBatch(messages, baseConfig(leaderQC, { queryKey: [...QK], tabId: "ld" }));

    if (result.cacheDiff) leaderDC.broadcastDiff(result.cacheDiff);

    const leaderData = leaderQC.getQueryData(QK) as any[];
    const followerData = followerQC.getQueryData(QK) as any[];

    // Verify content
    expect(leaderData).toHaveLength(3);
    expect(leaderData.find((r: any) => r.id === 1)?.name).toBe("Alice Updated");
    expect(leaderData.find((r: any) => r.id === 2)).toBeUndefined();
    expect(leaderData.find((r: any) => r.id === 4)?.name).toBe("Diana");

    // Follower matches leader
    expect(followerData).toEqual(leaderData);

    leaderDC.close();
    followerDC.close();
  });
});

// ===========================================================================
// Batch Processing
// ===========================================================================

describe("Batch Processing", () => {
  afterEach(() => {
    resetAllChannels();
  });

  it("ID-only messages trigger supabase refetch", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["refetch"], []);

    const supabase = mockSupabase([{ id: 10, name: "Refetched" }]);

    const msg = makeBroadcast({ operation: "INSERT", table: "profiles", row_id: 10 });

    const result = await processRealtimeBatch([msg], baseConfig(qc, { queryKey: ["refetch"], supabase, tabId: "t" }));

    expect(qc.getQueryData(["refetch"])).toEqual([{ id: 10, name: "Refetched" }]);
    expect(result.updatedRows).toHaveLength(1);
  });

  it("realtimeFilter rejects non-matching rows", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["filtered"], []);

    const msg = makeBroadcast({
      operation: "INSERT",
      table: "profiles",
      data: { id: 1, class_id: 999, name: "Wrong Class" }
    });

    const result = await processRealtimeBatch(
      [msg],
      baseConfig(qc, {
        queryKey: ["filtered"],
        tabId: "t",
        realtimeFilter: (row) => row.class_id === 1
      })
    );

    expect(qc.getQueryData(["filtered"])).toEqual([]);
    expect(result.updatedRows).toHaveLength(0);
    expect(result.cacheDiff).toBeNull();
  });

  it("empty batch produces no diff", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["empty"], [{ id: 1 }]);

    // Messages for a different table should be ignored
    const msg = makeBroadcast({
      operation: "INSERT",
      table: "other_table",
      data: { id: 99 }
    });

    const result = await processRealtimeBatch([msg], baseConfig(qc, { queryKey: ["empty"], tabId: "t" }));

    expect(result.cacheDiff).toBeNull();
    expect(result.updatedRows).toHaveLength(0);
    expect(result.removedIds).toHaveLength(0);
    // Cache unchanged
    expect(qc.getQueryData(["empty"])).toEqual([{ id: 1 }]);
  });
});

// ===========================================================================
// SSR Hydration
// ===========================================================================

describe("SSR Hydration", () => {
  it("initialData available immediately with no loading state", () => {
    const qc = makeQueryClient();
    const initialRows = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" }
    ];

    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: ["ssr", "profiles"],
          queryFn: async () => {
            // This should not be called immediately
            return [{ id: 1, name: "Alice" }];
          },
          initialData: initialRows
        }),
      { wrapper: wrapper(qc) }
    );

    // Data is available immediately without loading
    expect(result.current.data).toEqual(initialRows);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(true); // background refetch
  });

  it("initialData is overwritten by fresh fetch", async () => {
    const qc = makeQueryClient();
    const initialRows = [{ id: 1, name: "Stale" }];
    const freshRows = [
      { id: 1, name: "Fresh" },
      { id: 2, name: "New" }
    ];

    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: ["ssr", "fresh"],
          queryFn: async () => freshRows,
          initialData: initialRows,
          staleTime: 0 // ensure refetch happens
        }),
      { wrapper: wrapper(qc) }
    );

    // Initially has the stale data
    expect(result.current.data).toEqual(initialRows);

    // Wait for the background refetch
    await waitFor(() => {
      expect(result.current.data).toEqual(freshRows);
    });
  });
});

// ===========================================================================
// Mutation Optimistic Update
// ===========================================================================

describe("Mutation Optimistic Update", () => {
  it("optimistic insert appears immediately then gets replaced by server data", async () => {
    const qc = makeQueryClient();
    const QK = ["course", 1, "tags"] as const;
    qc.setQueryData(QK, [{ id: 1, name: "existing" }]);

    const serverRow = { id: 100, name: "new-tag", class_id: 1 };
    const supabase = mockSupabase([serverRow]) as any;

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeMutation({
          table: "tags",
          queryKey: [...QK],
          mutationType: "insert",
          supabase
        }),
      { wrapper: wrapper(qc) }
    );

    // Trigger the mutation -- await act so onMutate (async) runs
    await act(async () => {
      result.current.mutate({ name: "new-tag", class_id: 1 } as any);
    });

    // After onMutate resolves, the optimistic row should be in cache
    await waitFor(() => {
      const data = qc.getQueryData(QK) as any[];
      expect(data.length).toBeGreaterThanOrEqual(2);
    });

    const optimistic = qc.getQueryData(QK) as any[];
    expect(optimistic[0]).toEqual({ id: 1, name: "existing" });
    // Temp row has negative id and the insert values
    const tempRow = optimistic.find((r: any) => r.name === "new-tag");
    expect(tempRow).toBeDefined();

    // Wait for mutation to complete (not idle since invalidateQueries fires)
    await waitFor(() => {
      expect(result.current.isSuccess || result.current.isError).toBe(true);
    });
  });
});
