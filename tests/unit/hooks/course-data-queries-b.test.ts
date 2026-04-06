import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
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
// Mock CourseDataContext
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockCtxValue: any = {};

jest.mock("@/hooks/course-data/useCourseDataContext", () => ({
  useCourseDataContext: () => mockCtxValue
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } }
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

/**
 * Build a mock supabase client whose fluent `.from().select().eq().eq().or()`
 * chain always resolves to `{ data, error }`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockSupabase(data: any[] = [], error: any = null) {
  // Build a self-returning proxy so any chain of .select/.eq/.or resolves
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function fluent(): any {
    const obj: Record<string, any> = {
      select: jest.fn(() => obj),
      eq: jest.fn(() => obj),
      or: jest.fn(() => obj),
      order: jest.fn(() => obj),
      single: jest.fn().mockResolvedValue({ data: data[0] ?? null, error }),
      then: undefined as unknown
    };
    // Make the object itself thenable so `await query` works
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (obj as any).then = (resolve: any, reject: any) => Promise.resolve({ data, error }).then(resolve, reject);
    return obj;
  }

  return {
    from: jest.fn(() => fluent())
  };
}

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import { useDiscussionTopicsQuery } from "@/hooks/course-data/useDiscussionTopicsQuery";
import { useNotificationsQuery } from "@/hooks/course-data/useNotificationsQuery";
import { useRepositoriesQuery } from "@/hooks/course-data/useRepositoriesQuery";
import { useGradebookColumnsQuery } from "@/hooks/course-data/useGradebookColumnsQuery";

// ===========================================================================
// Tests
// ===========================================================================

describe("Phase 3 Batch 1B — course-data query hooks", () => {
  const COURSE_ID = 42;
  const USER_ID = "user-abc-123";
  const PROFILE_ID = "profile-xyz";

  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. useDiscussionTopicsQuery returns topics
  // -----------------------------------------------------------------------
  it("useDiscussionTopicsQuery fetches discussion topics", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const topics = [
      { id: 1, class_id: COURSE_ID, title: "General" },
      { id: 2, class_id: COURSE_ID, title: "HW Help" }
    ];
    const supabase = createMockSupabase(topics);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useDiscussionTopicsQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(topics);
    expect(supabase.from).toHaveBeenCalledWith("discussion_topics");
  });

  // -----------------------------------------------------------------------
  // 2. useNotificationsQuery includes userId in queryKey
  // -----------------------------------------------------------------------
  it("useNotificationsQuery includes userId in queryKey", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const notifications = [{ id: 10, class_id: COURSE_ID, user_id: USER_ID, message: "hello" }];
    const supabase = createMockSupabase(notifications);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useNotificationsQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Verify data came through
    expect(result.current.data).toEqual(notifications);

    // Verify queryKey includes userId — check the cache
    const cached = qc.getQueryData(["course", COURSE_ID, "notifications", USER_ID]);
    expect(cached).toEqual(notifications);
  });

  // -----------------------------------------------------------------------
  // 3. useRepositoriesQuery staff vs student
  // -----------------------------------------------------------------------
  it("useRepositoriesQuery — staff fetches all repos", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const repos = [
      { id: 1, class_id: COURSE_ID, profile_id: "p1" },
      { id: 2, class_id: COURSE_ID, profile_id: "p2" }
    ];
    const supabase = createMockSupabase(repos);

    // Simulate HydrationBoundary by pre-populating the QueryClient cache
    qc.setQueryData(["course", COURSE_ID, "repositories", "staff"], repos);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: true
    };

    const { result } = renderHook(() => useRepositoriesQuery(), {
      wrapper: createWrapper(qc)
    });

    // Staff gets pre-populated cache data immediately
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(repos);

    // Staff queryKey uses 'staff'
    const cached = qc.getQueryData(["course", COURSE_ID, "repositories", "staff"]);
    expect(cached).toEqual(repos);
  });

  it("useRepositoriesQuery — student uses profileId in queryKey", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const repos = [{ id: 3, class_id: COURSE_ID, profile_id: PROFILE_ID }];
    const supabase = createMockSupabase(repos);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useRepositoriesQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(repos);

    // Student queryKey uses profileId
    const cached = qc.getQueryData(["course", COURSE_ID, "repositories", PROFILE_ID]);
    expect(cached).toEqual(repos);
  });

  // -----------------------------------------------------------------------
  // 4. useGradebookColumnsQuery returns columns
  // -----------------------------------------------------------------------
  it("useGradebookColumnsQuery fetches gradebook columns", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const columns = [
      { id: 1, class_id: COURSE_ID, name: "Homework" },
      { id: 2, class_id: COURSE_ID, name: "Exam" }
    ];
    const supabase = createMockSupabase(columns);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useGradebookColumnsQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(columns);
    expect(supabase.from).toHaveBeenCalledWith("gradebook_columns");
  });

  // -----------------------------------------------------------------------
  // 5. Hooks use pre-populated cache (HydrationBoundary)
  // -----------------------------------------------------------------------
  it("hooks use pre-populated cache — data available immediately without loading", () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const topics = [{ id: 1, class_id: COURSE_ID, title: "Announcements" }];
    const columns = [{ id: 1, class_id: COURSE_ID, name: "Final" }];
    // Simulate HydrationBoundary by pre-populating the QueryClient cache
    qc.setQueryData(["course", COURSE_ID, "discussion_topics"], topics);
    qc.setQueryData(["course", COURSE_ID, "gradebook_columns"], columns);
    const supabase = createMockSupabase();

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    // Discussion topics — has pre-populated cache
    const { result: topicsResult } = renderHook(() => useDiscussionTopicsQuery(), { wrapper: createWrapper(qc) });

    expect(topicsResult.current.isLoading).toBe(false);
    expect(topicsResult.current.data).toEqual(topics);

    // Gradebook columns — uses the same QueryClient (cache was pre-populated above)
    const { result: colsResult } = renderHook(() => useGradebookColumnsQuery(), { wrapper: createWrapper(qc) });

    expect(colsResult.current.isLoading).toBe(false);
    expect(colsResult.current.data).toEqual(columns);
  });
});
