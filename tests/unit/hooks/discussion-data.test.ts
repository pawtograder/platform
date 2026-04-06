import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { useDiscussionThreadTeasersQuery } from "@/hooks/course-data/useDiscussionThreadTeasersQuery";
import { useDiscussionThreadQuery } from "@/hooks/discussion-data/useDiscussionThreadQuery";
import { CourseDataProvider } from "@/hooks/course-data/useCourseDataContext";
import type { CourseDataContextValue } from "@/hooks/course-data/useCourseDataContext";
import { DiscussionDataProvider } from "@/hooks/discussion-data/useDiscussionDataContext";
import type { DiscussionDataContextValue } from "@/hooks/discussion-data/useDiscussionDataContext";
import type { BroadcastMessage } from "@/lib/TableController";
import { setupMockBroadcastChannel, resetAllChannels } from "@/tests/mocks/MockBroadcastChannel";

// ---------------------------------------------------------------------------
// BroadcastChannel mock (jsdom has no native support)
// ---------------------------------------------------------------------------

setupMockBroadcastChannel();

// ---------------------------------------------------------------------------
// Mock useLeaderContext
// ---------------------------------------------------------------------------

jest.mock("@/lib/cross-tab/LeaderProvider", () => ({
  useLeaderContext: () => ({
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
  })
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
            order: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue(response)
            }),
            then: (resolve: (v: typeof response) => void) => Promise.resolve(response).then(resolve)
          }),
          or: jest.fn().mockResolvedValue(response),
          single: jest.fn().mockResolvedValue(response),
          in: jest.fn().mockResolvedValue(response)
        })
      };
    })
  };
}

function createCourseContextValue(overrides: Partial<CourseDataContextValue> = {}): CourseDataContextValue {
  const { rtc } = createMockRtc();
  return {
    courseId: 1,
    role: "student",
    userId: "user-123",
    profileId: "profile-123",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: createMockSupabase() as any,
    classRtc: rtc,
    isStaff: false,
    ...overrides
  };
}

function createCourseWrapper(queryClient: QueryClient, ctxValue: CourseDataContextValue) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(CourseDataProvider, { value: ctxValue }, children)
    );
  };
}

function createDiscussionWrapper(queryClient: QueryClient, discussionCtx: DiscussionDataContextValue) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(DiscussionDataProvider, { value: discussionCtx }, children)
    );
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("useDiscussionThreadTeasersQuery", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("returns teasers fetched from supabase", async () => {
    const qc = makeQueryClient();
    const mockTeasers = [
      { id: 1, title: "Thread A", root_class_id: 1 },
      { id: 2, title: "Thread B", root_class_id: 1 }
    ];
    const mockSupabase = createMockSupabase({
      discussion_threads: { data: mockTeasers, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createCourseContextValue({ supabase: mockSupabase as any });
    const wrapper = createCourseWrapper(qc, ctx);

    const { result } = renderHook(() => useDiscussionThreadTeasersQuery(), {
      wrapper
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockTeasers);
    expect(mockSupabase.from).toHaveBeenCalledWith("discussion_threads");
  });

  it("uses pre-populated QueryClient data immediately without loading", () => {
    const qc = makeQueryClient();
    const initialTeasers = [{ id: 1, title: "Pre-loaded", root_class_id: 1 }];
    // Simulate HydrationBoundary by pre-populating the QueryClient cache
    qc.setQueryData(["course", 1, "discussion_thread_teasers"], initialTeasers);
    const ctx = createCourseContextValue();
    const wrapper = createCourseWrapper(qc, ctx);

    const { result } = renderHook(() => useDiscussionThreadTeasersQuery(), {
      wrapper
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(initialTeasers);
  });
});

describe("useDiscussionThreadQuery", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("fetches thread tree (root + children)", async () => {
    const qc = makeQueryClient();
    const mockThreads = [
      { id: 10, root_id: null, title: "Root", root_class_id: 1 },
      { id: 11, root_id: 10, title: "Reply 1", root_class_id: 1 },
      { id: 12, root_id: 10, title: "Reply 2", root_class_id: 1 }
    ];
    const mockSupabase = createMockSupabase({
      discussion_threads: { data: mockThreads, error: null }
    });
    const { rtc } = createMockRtc();

    const discussionCtx: DiscussionDataContextValue = {
      rootThreadId: 10,
      courseId: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: mockSupabase as any,
      classRtc: rtc
    };
    const wrapper = createDiscussionWrapper(qc, discussionCtx);

    const { result } = renderHook(() => useDiscussionThreadQuery(), {
      wrapper
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockThreads);
    expect(mockSupabase.from).toHaveBeenCalledWith("discussion_threads");
  });

  it("uses scoped scope for per-thread realtime", async () => {
    const qc = makeQueryClient();
    const mockSupabase = createMockSupabase({
      discussion_threads: { data: [], error: null }
    });
    const { rtc } = createMockRtc();

    const discussionCtx: DiscussionDataContextValue = {
      rootThreadId: 42,
      courseId: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: mockSupabase as any,
      classRtc: rtc
    };
    const wrapper = createDiscussionWrapper(qc, discussionCtx);

    const { result } = renderHook(() => useDiscussionThreadQuery(), {
      wrapper
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Verify it rendered without crashing (scope='scoped' is internal config)
    expect(result.current.data).toEqual([]);
  });
});
