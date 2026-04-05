import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import React from "react";
import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import type { CacheDiff } from "@/lib/cross-tab/RealtimeDiffChannel";
import type { BroadcastMessage } from "@/lib/TableController";

// ---------------------------------------------------------------------------
// BroadcastChannel mock (jsdom has no native support)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const channelRegistry = new Map<string, Set<any>>();

class MockBroadcastChannel {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((ev: { data: any }) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    if (!channelRegistry.has(name)) channelRegistry.set(name, new Set());
    channelRegistry.get(name)!.add(this);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postMessage(data: any) {
    const peers = channelRegistry.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== this && peer.onmessage) {
        peer.onmessage({ data: JSON.parse(JSON.stringify(data)) });
      }
    }
  }

  close() {
    channelRegistry.get(this.name)?.delete(this);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).BroadcastChannel = MockBroadcastChannel;

// ---------------------------------------------------------------------------
// Mock useLeaderContext — must be mocked before import resolves
// ---------------------------------------------------------------------------

const mockLeaderCtx = {
  isLeader: true,
  leader: {
    isLeader: true,
    tabId: "test-tab",
    onLeaderChange: jest.fn(() => () => {}),
    close: jest.fn()
  },
  diffChannel: {
    broadcastDiff: jest.fn(),
    onDiff: jest.fn(() => () => {}),
    close: jest.fn()
  },
  tabId: "test-tab"
};

jest.mock("@/lib/cross-tab/LeaderProvider", () => ({
  useLeaderContext: () => mockLeaderCtx
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false }
    }
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function createMockRtc() {
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

  return { rtc, subscribers };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockSupabase(data: any[] = [], error: any = null) {
  const singleResult = data.length > 0 ? data[0] : null;
  return {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: singleResult, error })
          }),
          order: jest.fn().mockResolvedValue({ data, error })
        }),
        single: jest.fn().mockResolvedValue({ data: singleResult, error }),
        in: jest.fn().mockResolvedValue({ data, error }),
        gt: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({ data, error })
        })
      }),
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data: singleResult, error })
        })
      }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: singleResult, error })
          })
        })
      }),
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ data: null, error })
      })
    })
  };
}

// ===========================================================================
// Tests for useSupabaseRealtimeQuery
// ===========================================================================

describe("useSupabaseRealtimeQuery", () => {
  const TABLE = "profiles" as const;
  const QUERY_KEY = ["test", "profiles"] as const;

  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  // 1. Fetches data on mount
  it("fetches data on mount", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const mockData = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" }
    ];
    const queryFn = jest.fn().mockResolvedValue({ data: mockData, error: null });

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeQuery({
          queryKey: QUERY_KEY,
          table: TABLE,
          queryFn,
          classRtc: rtc,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: createMockSupabase() as any,
          scope: "class"
        }),
      { wrapper: createWrapper(qc) }
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockData);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  // 2. Loading state
  it("is in loading state initially, then resolves", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    let resolve: (v: { data: unknown[]; error: null }) => void;
    const queryFn = jest.fn(
      () =>
        new Promise<{ data: unknown[]; error: null }>((r) => {
          resolve = r;
        })
    );

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeQuery({
          queryKey: QUERY_KEY,
          table: TABLE,
          queryFn,
          classRtc: rtc,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: createMockSupabase() as any,
          scope: "class"
        }),
      { wrapper: createWrapper(qc) }
    );

    // Initially loading
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();

    // Resolve the query
    await act(async () => {
      resolve!({ data: [{ id: 1 }], error: null });
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual([{ id: 1 }]);
  });

  // 3. Error handling
  it("surfaces errors from queryFn", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const queryFn = jest.fn().mockResolvedValue({
      data: null,
      error: new Error("fetch failed")
    });

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeQuery({
          queryKey: QUERY_KEY,
          table: TABLE,
          queryFn,
          classRtc: rtc,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: createMockSupabase() as any,
          scope: "class"
        }),
      { wrapper: createWrapper(qc) }
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error!.message).toBe("fetch failed");
  });

  // 4. Initial data
  it("uses initialData immediately without loading", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const initialData = [{ id: 1, name: "Pre-loaded" }];
    const queryFn = jest.fn().mockResolvedValue({ data: initialData, error: null });

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeQuery({
          queryKey: QUERY_KEY,
          table: TABLE,
          queryFn,
          classRtc: rtc,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: createMockSupabase() as any,
          scope: "class",
          initialData
        }),
      { wrapper: createWrapper(qc) }
    );

    // Initial data is available immediately — no loading state
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(initialData);
  });

  // 5. Enabled=false
  it("does not execute queryFn when enabled is false", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const queryFn = jest.fn().mockResolvedValue({ data: [], error: null });

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeQuery({
          queryKey: QUERY_KEY,
          table: TABLE,
          queryFn,
          classRtc: rtc,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: createMockSupabase() as any,
          scope: "class",
          enabled: false
        }),
      { wrapper: createWrapper(qc) }
    );

    // Should remain in pending status (not loading, not fetching)
    expect(result.current.fetchStatus).toBe("idle");
    expect(queryFn).not.toHaveBeenCalled();
  });

  // 6. Select transform
  it("applies select transform to data", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const rawData = [
      { id: 1, name: "Alice", score: 90 },
      { id: 2, name: "Bob", score: 85 }
    ];
    const queryFn = jest.fn().mockResolvedValue({ data: rawData, error: null });

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeQuery({
          queryKey: QUERY_KEY,
          table: TABLE,
          queryFn,
          classRtc: rtc,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: createMockSupabase() as any,
          scope: "class",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          select: (data: any[]) => data.filter((d) => d.score >= 90)
        }),
      { wrapper: createWrapper(qc) }
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual([{ id: 1, name: "Alice", score: 90 }]);
  });

  // 7. Calls useRealtimeBridge (leader subscribes to classRtc)
  it("sets up realtime bridge — leader subscribes to classRtc", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const queryFn = jest.fn().mockResolvedValue({ data: [], error: null });

    // Ensure mock leader context says we are leader
    mockLeaderCtx.isLeader = true;
    mockLeaderCtx.leader.isLeader = true;

    renderHook(
      () =>
        useSupabaseRealtimeQuery({
          queryKey: QUERY_KEY,
          table: TABLE,
          queryFn,
          classRtc: rtc,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: createMockSupabase() as any,
          scope: "class"
        }),
      { wrapper: createWrapper(qc) }
    );

    // The realtime bridge (via useRealtimeBridge) should have subscribed
    expect(rtc.subscribeToTable).toHaveBeenCalledWith(TABLE, expect.any(Function));
  });
});

// ===========================================================================
// Tests for useSupabaseRealtimeMutation
// ===========================================================================

describe("useSupabaseRealtimeMutation", () => {
  const TABLE = "tags" as const;
  const QUERY_KEY = ["test", "tags"] as const;

  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  // 8. Insert mutation
  it("insert mutation calls supabase.from(table).insert()", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(QUERY_KEY, []);

    const insertedRow = { id: 100, name: "new-tag", class_id: 1 };
    const mockSupabase = createMockSupabase([insertedRow]);

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeMutation({
          table: TABLE,
          queryKey: QUERY_KEY,
          mutationType: "insert",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: mockSupabase as any
        }),
      { wrapper: createWrapper(qc) }
    );

    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.current.mutate({ name: "new-tag", class_id: 1 } as any);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockSupabase.from).toHaveBeenCalledWith(TABLE);
    expect(mockSupabase.from(TABLE).insert).toHaveBeenCalled();
  });

  // 9. Update mutation
  it("update mutation calls supabase.from(table).update().eq()", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(QUERY_KEY, [{ id: 1, name: "old-name" }]);

    const updatedRow = { id: 1, name: "updated-name" };
    const mockSupabase = createMockSupabase([updatedRow]);

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeMutation({
          table: TABLE,
          queryKey: QUERY_KEY,
          mutationType: "update",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: mockSupabase as any
        }),
      { wrapper: createWrapper(qc) }
    );

    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.current.mutate({ id: 1, values: { name: "updated-name" } } as any);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockSupabase.from).toHaveBeenCalledWith(TABLE);
    expect(mockSupabase.from(TABLE).update).toHaveBeenCalled();
  });

  // 10. Delete mutation
  it("delete mutation calls supabase.from(table).delete().eq()", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(QUERY_KEY, [{ id: 1, name: "doomed" }]);

    const mockSupabase = createMockSupabase();

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeMutation({
          table: TABLE,
          queryKey: QUERY_KEY,
          mutationType: "delete",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: mockSupabase as any
        }),
      { wrapper: createWrapper(qc) }
    );

    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.current.mutate({ id: 1 } as any);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockSupabase.from).toHaveBeenCalledWith(TABLE);
    expect(mockSupabase.from(TABLE).delete).toHaveBeenCalled();
  });

  // 11. Optimistic insert
  it("optimistic insert appends temp row to cache immediately", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(QUERY_KEY, [{ id: 1, name: "existing" }]);

    // Use a promise we control so we can inspect cache before mutation settles
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveMutation: (v: any) => void;
    const mockSupabase = {
      from: jest.fn().mockReturnValue({
        insert: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn(
              () =>
                new Promise((r) => {
                  resolveMutation = r;
                })
            )
          })
        }),
        // Provide other methods for invalidation queries
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: [], error: null })
          })
        })
      })
    };

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeMutation({
          table: TABLE,
          queryKey: QUERY_KEY,
          mutationType: "insert",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: mockSupabase as any
        }),
      { wrapper: createWrapper(qc) }
    );

    // Start mutation but don't resolve yet
    act(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.current.mutate({ name: "optimistic-tag", class_id: 1 } as any);
    });

    // Wait for onMutate to run
    await waitFor(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cached = qc.getQueryData<any[]>(QUERY_KEY);
      expect(cached).toHaveLength(2);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cached = qc.getQueryData<any[]>(QUERY_KEY);
    expect(cached![0]).toEqual({ id: 1, name: "existing" });
    // Temp row has a negative id
    expect(cached![1].id).toBeLessThan(0);
    expect(cached![1].name).toBe("optimistic-tag");

    // Clean up: resolve the mutation
    await act(async () => {
      resolveMutation!({ data: { id: 200, name: "optimistic-tag", class_id: 1 }, error: null });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  // 12. Optimistic rollback on error
  it("rolls back cache on mutation error", async () => {
    const qc = makeQueryClient();
    const originalData = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" }
    ];
    qc.setQueryData(QUERY_KEY, originalData);

    const mockSupabase = {
      from: jest.fn().mockReturnValue({
        delete: jest.fn().mockReturnValue({
          eq: jest.fn().mockRejectedValue(new Error("delete failed"))
        }),
        // For invalidation
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: originalData, error: null })
          })
        })
      })
    };

    const { result } = renderHook(
      () =>
        useSupabaseRealtimeMutation({
          table: TABLE,
          queryKey: QUERY_KEY,
          mutationType: "delete",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: mockSupabase as any
        }),
      { wrapper: createWrapper(qc) }
    );

    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.current.mutate({ id: 1 } as any);
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Cache should be restored to original data (rollback)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cached = qc.getQueryData<any[]>(QUERY_KEY);
    expect(cached).toEqual(originalData);
  });
});
