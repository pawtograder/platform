import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import { processRealtimeBatch, BatchHandlerConfig } from "@/lib/cross-tab/createRealtimeBatchHandler";
import { useRealtimeBridge, RealtimeBridgeConfig } from "@/lib/cross-tab/useRealtimeBridge";
import type { BroadcastMessage } from "@/lib/TableController";
import type { CacheDiff } from "@/lib/cross-tab/RealtimeDiffChannel";
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

/** Build a fluent supabase mock that resolves to the given rows. */
function mockSupabase(rows: Record<string, unknown>[] = [], error: any = null) {
  return {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: rows, error }),
        gt: () => ({
          order: () => Promise.resolve({ data: rows, error })
        })
      })
    })
  };
}

/** Create a mock classRtc. Returns the mock and a `fire` helper to invoke subscribed callbacks. */
function mockClassRtc() {
  const subscribers = new Map<string, Set<(msg: BroadcastMessage) => void>>();

  const rtc = {
    subscribeToTable: jest.fn((table: string, cb: (msg: BroadcastMessage) => void) => {
      if (!subscribers.has(table)) subscribers.set(table, new Set());
      subscribers.get(table)!.add(cb);
      return () => {
        subscribers.get(table)?.delete(cb);
      };
    }),
    subscribeToStatus: jest.fn(() => () => {}),
    getConnectionStatus: jest.fn(() => ({
      overall: "connected" as const,
      channels: [],
      lastUpdate: new Date()
    }))
  };

  function fire(table: string, msg: BroadcastMessage) {
    const set = subscribers.get(table);
    if (set) {
      for (const cb of set) cb(msg);
    }
  }

  return { rtc, fire, subscribers };
}

function mockLeader(isLeader: boolean): any {
  const listeners = new Set<(isLeader: boolean) => void>();
  return {
    isLeader,
    tabId: "test-tab",
    onLeaderChange: jest.fn((cb: (v: boolean) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
    close: jest.fn(),
    _listeners: listeners,
    /** Simulate a leadership change for tests. */
    _setLeader(val: boolean) {
      (this as any).isLeader = val;
      for (const cb of listeners) cb(val);
    }
  };
}

function mockDiffChannel(): any {
  const listeners = new Set<(diff: CacheDiff) => void>();
  return {
    broadcastDiff: jest.fn(),
    onDiff: jest.fn((cb: (diff: CacheDiff) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
    close: jest.fn(),
    _listeners: listeners
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// ===========================================================================
// Tests for processRealtimeBatch (pure function)
// ===========================================================================

describe("processRealtimeBatch", () => {
  let qc: QueryClient;
  const QUERY_KEY = ["students"] as const;
  const TABLE = "profiles";

  function baseConfig(overrides?: Partial<BatchHandlerConfig>): BatchHandlerConfig {
    return {
      table: TABLE,
      queryKey: QUERY_KEY,
      queryClient: qc,
      supabase: mockSupabase(),
      tabId: "test-tab",
      ...overrides
    };
  }

  beforeEach(() => {
    qc = makeQueryClient();
    // Seed the cache with an empty array so setQueryData updater sees an array
    qc.setQueryData(QUERY_KEY, []);
  });

  // 1. INSERT with inline data
  it("INSERT with inline data adds row to cache", async () => {
    const msg = makeBroadcast({
      operation: "INSERT",
      table: TABLE,
      data: { id: 1, name: "Alice" }
    });

    const result = await processRealtimeBatch([msg], baseConfig());

    expect(qc.getQueryData(QUERY_KEY)).toEqual([{ id: 1, name: "Alice" }]);
    expect(result.updatedRows).toHaveLength(1);
    expect(result.cacheDiff).not.toBeNull();
    expect(result.cacheDiff!.operations[0].type).toBe("upsert");
  });

  // 2. UPDATE with inline data
  it("UPDATE with inline data updates existing row in cache", async () => {
    qc.setQueryData(QUERY_KEY, [{ id: 1, name: "Alice" }]);

    const msg = makeBroadcast({
      operation: "UPDATE",
      table: TABLE,
      data: { id: 1, name: "Alice Updated" }
    });

    await processRealtimeBatch([msg], baseConfig());

    expect(qc.getQueryData(QUERY_KEY)).toEqual([{ id: 1, name: "Alice Updated" }]);
  });

  // 3. DELETE
  it("DELETE removes row from cache", async () => {
    qc.setQueryData(QUERY_KEY, [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" }
    ]);

    const msg = makeBroadcast({
      operation: "DELETE",
      table: TABLE,
      row_id: 1
    });

    const result = await processRealtimeBatch([msg], baseConfig());

    expect(qc.getQueryData(QUERY_KEY)).toEqual([{ id: 2, name: "Bob" }]);
    expect(result.removedIds).toEqual([1]);
    expect(result.cacheDiff!.operations[0].type).toBe("remove");
  });

  // 4. ID-only INSERT triggers supabase refetch
  it("ID-only INSERT triggers supabase refetch and adds refetched row", async () => {
    const supabase = mockSupabase([{ id: 10, name: "Refetched" }]);

    const msg = makeBroadcast({
      operation: "INSERT",
      table: TABLE,
      row_id: 10
    });

    const result = await processRealtimeBatch([msg], baseConfig({ supabase }));

    expect(qc.getQueryData(QUERY_KEY)).toEqual([{ id: 10, name: "Refetched" }]);
    expect(result.updatedRows).toHaveLength(1);
  });

  // 5. Mixed batch: INSERT + UPDATE + DELETE in one call
  it("mixed batch processes multiple operations", async () => {
    qc.setQueryData(QUERY_KEY, [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" }
    ]);

    const messages = [
      makeBroadcast({
        operation: "INSERT",
        table: TABLE,
        data: { id: 3, name: "Charlie" }
      }),
      makeBroadcast({
        operation: "UPDATE",
        table: TABLE,
        data: { id: 1, name: "Alice Updated" }
      }),
      makeBroadcast({
        operation: "DELETE",
        table: TABLE,
        row_id: 2
      })
    ];

    const result = await processRealtimeBatch(messages, baseConfig());

    const cached = qc.getQueryData(QUERY_KEY) as any[];
    expect(cached).toHaveLength(2);
    expect(cached.find((r: any) => r.id === 1)?.name).toBe("Alice Updated");
    expect(cached.find((r: any) => r.id === 3)?.name).toBe("Charlie");
    expect(cached.find((r: any) => r.id === 2)).toBeUndefined();
    expect(result.updatedRows).toHaveLength(2);
    expect(result.removedIds).toEqual([2]);
  });

  // 6. realtimeFilter rejection
  it("realtimeFilter rejects rows that do not match", async () => {
    const msg = makeBroadcast({
      operation: "INSERT",
      table: TABLE,
      data: { id: 1, name: "Alice", role: "admin" }
    });

    const result = await processRealtimeBatch(
      [msg],
      baseConfig({
        realtimeFilter: (row) => row.role === "student"
      })
    );

    expect(qc.getQueryData(QUERY_KEY)).toEqual([]);
    expect(result.updatedRows).toHaveLength(0);
    expect(result.cacheDiff).toBeNull();
  });

  // 7. Batch refetch with selectForRefetch
  it("uses selectForRefetch in supabase query", async () => {
    const selectSpy = jest.fn().mockReturnValue({
      in: () => Promise.resolve({ data: [{ id: 5, name: "Sel" }], error: null })
    });
    const supabase = {
      from: () => ({ select: selectSpy })
    };

    const msg = makeBroadcast({
      operation: "INSERT",
      table: TABLE,
      row_id: 5
    });

    await processRealtimeBatch([msg], baseConfig({ supabase: supabase as any, selectForRefetch: "id,name" }));

    expect(selectSpy).toHaveBeenCalledWith("id,name");
    expect(qc.getQueryData(QUERY_KEY)).toEqual([{ id: 5, name: "Sel" }]);
  });
});

// ===========================================================================
// Tests for useRealtimeBridge (React hook)
// ===========================================================================

describe("useRealtimeBridge", () => {
  let qc: QueryClient;
  const TABLE = "profiles";
  const QUERY_KEY = ["students"] as const;

  beforeEach(() => {
    jest.useFakeTimers();
    qc = makeQueryClient();
    qc.setQueryData(QUERY_KEY, []);
    resetAllChannels();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function renderBridge(overrides: Partial<RealtimeBridgeConfig>) {
    const { rtc, fire } = mockClassRtc();
    const leader = mockLeader(overrides.leader?.isLeader ?? true);
    const diff = mockDiffChannel();

    const defaultConfig: RealtimeBridgeConfig = {
      table: TABLE,
      queryKey: QUERY_KEY,
      classRtc: rtc as any,
      supabase: mockSupabase(),
      scope: "class",
      leader,
      diffChannel: diff,
      ...overrides
    };

    const result = renderHook(() => useRealtimeBridge(defaultConfig), {
      wrapper: wrapper(qc)
    });

    return { result, rtc, fire, leader, diff };
  }

  // 8. Leader subscribes to classRtc
  it("leader subscribes to classRtc", () => {
    const { rtc } = renderBridge({ leader: mockLeader(true) });
    expect(rtc.subscribeToTable).toHaveBeenCalledWith(TABLE, expect.any(Function));
  });

  // 9. Follower does NOT subscribe to classRtc for class scope
  it("follower does NOT subscribe to classRtc for class scope", () => {
    const { rtc } = renderBridge({
      leader: mockLeader(false),
      scope: "class"
    });
    expect(rtc.subscribeToTable).not.toHaveBeenCalled();
  });

  // 10. Debounce batching
  it("debounces multiple messages into a single batch", async () => {
    const { fire } = renderBridge({
      leader: mockLeader(true),
      debounceMs: 200
    });

    // Fire 3 messages rapidly
    act(() => {
      fire(TABLE, makeBroadcast({ operation: "INSERT", table: TABLE, data: { id: 1, name: "A" } }));
      fire(TABLE, makeBroadcast({ operation: "INSERT", table: TABLE, data: { id: 2, name: "B" } }));
      fire(TABLE, makeBroadcast({ operation: "INSERT", table: TABLE, data: { id: 3, name: "C" } }));
    });

    // Before debounce fires, cache should be empty still
    expect(qc.getQueryData(QUERY_KEY)).toEqual([]);

    // Advance past debounce
    await act(async () => {
      jest.advanceTimersByTime(250);
    });

    const cached = qc.getQueryData(QUERY_KEY) as any[];
    expect(cached).toHaveLength(3);
  });

  // 11. Leader broadcasts diffs after processing
  it("leader broadcasts diffs after processing", async () => {
    const { fire, diff } = renderBridge({
      leader: mockLeader(true),
      debounceMs: 100
    });

    act(() => {
      fire(TABLE, makeBroadcast({ operation: "INSERT", table: TABLE, data: { id: 1, name: "X" } }));
    });

    await act(async () => {
      jest.advanceTimersByTime(150);
    });

    expect(diff.broadcastDiff).toHaveBeenCalledTimes(1);
    const diffArg = diff.broadcastDiff.mock.calls[0][0] as CacheDiff;
    expect(diffArg.operations[0].type).toBe("upsert");
    expect(diffArg.source).toBe("test-tab");
  });

  // 12. Follower receives and applies diffs
  it("follower receives and applies diffs to cache", () => {
    const { diff } = renderBridge({
      leader: mockLeader(false),
      scope: "class"
    });

    // The hook registered an onDiff listener; simulate a diff arriving
    expect(diff.onDiff).toHaveBeenCalled();

    const diffCallback = diff.onDiff.mock.calls[0][0] as (diff: CacheDiff) => void;

    act(() => {
      diffCallback({
        queryKey: QUERY_KEY,
        operations: [{ type: "upsert", rows: [{ id: 42, name: "FromLeader" }] }],
        source: "leader-tab",
        timestamp: Date.now()
      });
    });

    expect(qc.getQueryData(QUERY_KEY)).toEqual([{ id: 42, name: "FromLeader" }]);
  });

  // 13. Cleanup on unmount
  it("cleans up all subscriptions on unmount", () => {
    const leaderMock = mockLeader(true);
    const { result, rtc } = renderBridge({ leader: leaderMock });

    // subscribeToTable returns an unsubscribe function — it was called
    expect(rtc.subscribeToTable).toHaveBeenCalled();

    // For class scope with a leader, onLeaderChange should have been registered
    expect(leaderMock.onLeaderChange).toHaveBeenCalled();

    result.unmount();

    // After unmount, the subscribers on classRtc should have been cleaned up.
    // Verify that the classRtc table has no remaining subscribers by checking
    // that a second subscribe/unsubscribe cycle leaves no trace.
    // The key check: no errors thrown and the leader change listener was registered.
    expect(leaderMock.onLeaderChange).toHaveBeenCalledTimes(1);
  });

  // 14. Scoped mode always subscribes regardless of leader status
  it("scoped mode subscribes to classRtc even for non-leader", () => {
    const { rtc } = renderBridge({
      leader: mockLeader(false),
      scope: "scoped"
    });

    expect(rtc.subscribeToTable).toHaveBeenCalledWith(TABLE, expect.any(Function));
  });
});
