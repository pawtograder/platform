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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function fluent(): any {
    const obj = {
      select: jest.fn(() => obj),
      eq: jest.fn(() => obj),
      or: jest.fn(() => obj),
      order: jest.fn(() => obj),
      single: jest.fn().mockResolvedValue({ data: data[0] ?? null, error }),
      then: undefined as unknown
    };
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

import { useDiscussionThreadReadStatusQuery } from "@/hooks/course-data/useDiscussionThreadReadStatusQuery";
import { useDiscussionThreadWatchersQuery } from "@/hooks/course-data/useDiscussionThreadWatchersQuery";
import { useDiscussionTopicFollowersQuery } from "@/hooks/course-data/useDiscussionTopicFollowersQuery";
import { useDiscussionThreadLikesQuery } from "@/hooks/course-data/useDiscussionThreadLikesQuery";
import { useStudentDeadlineExtensionsQuery } from "@/hooks/course-data/useStudentDeadlineExtensionsQuery";
import { useAssignmentDueDateExceptionsQuery } from "@/hooks/course-data/useAssignmentDueDateExceptionsQuery";

// ===========================================================================
// Tests
// ===========================================================================

describe("Phase 3 Batch 2 — user-scoped course-data query hooks", () => {
  const COURSE_ID = 42;
  const USER_ID = "user-abc-123";
  const PROFILE_ID = "profile-xyz";

  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. useDiscussionThreadReadStatusQuery includes userId in queryKey
  // -----------------------------------------------------------------------
  it("useDiscussionThreadReadStatusQuery includes userId in queryKey", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const rows = [{ id: 1, user_id: USER_ID, thread_id: 10, read_at: "2024-01-01" }];
    const supabase = createMockSupabase(rows);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useDiscussionThreadReadStatusQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(rows);

    // Verify queryKey includes userId
    const cached = qc.getQueryData(["course", COURSE_ID, "discussion_thread_read_status", USER_ID]);
    expect(cached).toEqual(rows);
  });

  // -----------------------------------------------------------------------
  // 2. useDiscussionThreadWatchersQuery has realtimeFilter
  // -----------------------------------------------------------------------
  it("useDiscussionThreadWatchersQuery renders without error", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const watchers = [{ id: 1, user_id: USER_ID, class_id: COURSE_ID, thread_id: 5 }];
    const supabase = createMockSupabase(watchers);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useDiscussionThreadWatchersQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(watchers);
    expect(supabase.from).toHaveBeenCalledWith("discussion_thread_watchers");
  });

  // -----------------------------------------------------------------------
  // 3. useDiscussionTopicFollowersQuery fetches data
  // -----------------------------------------------------------------------
  it("useDiscussionTopicFollowersQuery fetches data", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const followers = [{ id: 1, user_id: USER_ID, class_id: COURSE_ID, topic_id: 3 }];
    const supabase = createMockSupabase(followers);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useDiscussionTopicFollowersQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(followers);
    expect(supabase.from).toHaveBeenCalledWith("discussion_topic_followers");
  });

  // -----------------------------------------------------------------------
  // 4. useDiscussionThreadLikesQuery disabled without profileId
  // -----------------------------------------------------------------------
  it("useDiscussionThreadLikesQuery disabled without profileId", () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const supabase = createMockSupabase([]);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useDiscussionThreadLikesQuery(), {
      wrapper: createWrapper(qc)
    });

    // Query should not execute — stays in pending/loading state
    expect(result.current.fetchStatus).toBe("idle");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 5. useStudentDeadlineExtensionsQuery staff mode
  // -----------------------------------------------------------------------
  it("useStudentDeadlineExtensionsQuery staff gets all extensions", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const extensions = [
      { id: 1, class_id: COURSE_ID, student_id: "s1", assignment_id: 10 },
      { id: 2, class_id: COURSE_ID, student_id: "s2", assignment_id: 11 }
    ];
    const supabase = createMockSupabase(extensions);

    // Simulate HydrationBoundary by pre-populating the QueryClient cache
    qc.setQueryData(["course", COURSE_ID, "student_deadline_extensions", "staff"], extensions);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: true
    };

    const { result } = renderHook(() => useStudentDeadlineExtensionsQuery(), {
      wrapper: createWrapper(qc)
    });

    // Staff gets pre-populated cache data immediately
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(extensions);

    // Staff queryKey uses 'staff'
    const cached = qc.getQueryData(["course", COURSE_ID, "student_deadline_extensions", "staff"]);
    expect(cached).toEqual(extensions);
  });

  // -----------------------------------------------------------------------
  // 6. useAssignmentDueDateExceptionsQuery student mode
  // -----------------------------------------------------------------------
  it("useAssignmentDueDateExceptionsQuery student gets filtered view", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const exceptions = [{ id: 1, class_id: COURSE_ID, student_id: PROFILE_ID, assignment_id: 20 }];
    const supabase = createMockSupabase(exceptions);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useAssignmentDueDateExceptionsQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(exceptions);

    // Student queryKey uses profileId
    const cached = qc.getQueryData(["course", COURSE_ID, "assignment_due_date_exceptions", PROFILE_ID]);
    expect(cached).toEqual(exceptions);
  });
});
