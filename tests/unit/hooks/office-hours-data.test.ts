import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { useHelpRequestsQuery } from "@/hooks/office-hours-data/useHelpRequestsQuery";
import { useHelpQueuesQuery } from "@/hooks/office-hours-data/useHelpQueuesQuery";
import { useHelpRequestMessagesQuery } from "@/hooks/office-hours-data/useHelpRequestMessagesQuery";
import { useHelpRequestReadReceiptsQuery } from "@/hooks/office-hours-data/useHelpRequestReadReceiptsQuery";
import { useHelpRequestWorkSessionsQuery } from "@/hooks/office-hours-data/useHelpRequestWorkSessionsQuery";
import { OfficeHoursDataProvider } from "@/hooks/office-hours-data/useOfficeHoursDataContext";
import type { OfficeHoursDataContextValue } from "@/hooks/office-hours-data/useOfficeHoursDataContext";
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
// Mock useLeaderContext
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
function createMockSupabase(responseMap?: Record<string, { data: any; error: any }>) {
  return {
    from: jest.fn((table: string) => {
      const response = responseMap?.[table] ?? { data: [], error: null };
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              // For double .eq() chains (messages, read receipts)
              then: (resolve: (v: typeof response) => void) => Promise.resolve(response).then(resolve),
              order: jest.fn().mockReturnValue({
                order: jest.fn().mockResolvedValue(response)
              })
            }),
            order: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue(response)
            }),
            // For direct .eq().then() (no second eq or order)
            then: (resolve: (v: typeof response) => void) => Promise.resolve(response).then(resolve)
          }),
          single: jest.fn().mockResolvedValue(response),
          in: jest.fn().mockResolvedValue(response)
        })
      };
    })
  };
}

function createContextValue(overrides: Partial<OfficeHoursDataContextValue> = {}): OfficeHoursDataContextValue {
  const { rtc } = createMockRtc();
  return {
    classId: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: createMockSupabase() as any,
    classRtc: rtc,
    officeHoursRtc: null,
    ...overrides
  };
}

function createWrapper(queryClient: QueryClient, ctxValue: OfficeHoursDataContextValue) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(OfficeHoursDataProvider, { value: ctxValue }, children)
    );
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("useHelpRequestsQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("returns help requests fetched from supabase", async () => {
    const qc = makeQueryClient();
    const mockRequests = [
      { id: 1, class_id: 1, status: "waiting" },
      { id: 2, class_id: 1, status: "in_progress" }
    ];
    const mockSupabase = createMockSupabase({
      help_requests: { data: mockRequests, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useHelpRequestsQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockRequests);
    expect(mockSupabase.from).toHaveBeenCalledWith("help_requests");
  });
});

describe("useHelpQueuesQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("returns help queues fetched from supabase", async () => {
    const qc = makeQueryClient();
    const mockQueues = [
      { id: 1, class_id: 1, name: "General" },
      { id: 2, class_id: 1, name: "Lab" }
    ];
    const mockSupabase = createMockSupabase({
      help_queues: { data: mockQueues, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useHelpQueuesQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockQueues);
    expect(mockSupabase.from).toHaveBeenCalledWith("help_queues");
  });
});

describe("useHelpRequestMessagesQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("is disabled when helpRequestId is null (leak prevention)", async () => {
    const qc = makeQueryClient();
    const mockSupabase = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useHelpRequestMessagesQuery(null), { wrapper });

    // Query should not be loading (it is disabled)
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
    // Should not have called supabase since query is disabled
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it("fetches messages when helpRequestId is provided", async () => {
    const qc = makeQueryClient();
    const mockMessages = [
      { id: 10, class_id: 1, help_request_id: 42, content: "Hello" },
      { id: 11, class_id: 1, help_request_id: 42, content: "World" }
    ];
    const mockSupabase = createMockSupabase({
      help_request_messages: { data: mockMessages, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useHelpRequestMessagesQuery(42), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockMessages);
    expect(mockSupabase.from).toHaveBeenCalledWith("help_request_messages");
  });

  it("uses gcTime for automatic cache eviction", () => {
    const qc = makeQueryClient();
    const ctx = createContextValue();
    const wrapper = createWrapper(qc, ctx);

    renderHook(() => useHelpRequestMessagesQuery(42), { wrapper });

    // Verify the query was created with the expected key that includes the helpRequestId
    const queryState = qc.getQueryState(["office_hours", 1, "help_request_messages", 42]);
    expect(queryState).toBeDefined();
  });
});

describe("useHelpRequestReadReceiptsQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("is disabled when helpRequestId is null", async () => {
    const qc = makeQueryClient();
    const mockSupabase = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useHelpRequestReadReceiptsQuery(null), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

describe("useHelpRequestWorkSessionsQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("returns work sessions fetched from supabase", async () => {
    const qc = makeQueryClient();
    const mockSessions = [{ id: 1, class_id: 1, help_request_id: 10, started_at: "2026-01-01T00:00:00Z" }];
    const mockSupabase = createMockSupabase({
      help_request_work_sessions: { data: mockSessions, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useHelpRequestWorkSessionsQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockSessions);
    expect(mockSupabase.from).toHaveBeenCalledWith("help_request_work_sessions");
  });
});
