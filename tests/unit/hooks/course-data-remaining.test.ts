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
 * Build a mock supabase client whose fluent chain resolves to `{ data, error }`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockSupabase(data: any[] = [], error: any = null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function fluent(): any {
    const obj: Record<string, any> = {
      select: jest.fn(() => obj),
      eq: jest.fn(() => obj),
      is: jest.fn(() => obj),
      or: jest.fn(() => obj),
      order: jest.fn(() => obj),
      limit: jest.fn(() => obj),
      insert: jest.fn(() => obj),
      update: jest.fn(() => obj),
      delete: jest.fn(() => obj),
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

import { useLabSectionsQuery } from "@/hooks/course-data/useLabSectionsQuery";
import { useCalendarEventsQuery } from "@/hooks/course-data/useCalendarEventsQuery";
import { useLivePollsQuery } from "@/hooks/course-data/useLivePollsQuery";
import { useSurveysQuery } from "@/hooks/course-data/useSurveysQuery";
import { useLabSectionInsert } from "@/hooks/course-data/useLabSectionsMutation";

// ===========================================================================
// Tests
// ===========================================================================

describe("Phase 3 Batches 4 & 5 — remaining course-data hooks", () => {
  const COURSE_ID = 42;
  const USER_ID = "user-abc-123";
  const PROFILE_ID = "profile-xyz";

  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. useLabSectionsQuery returns sections
  // -----------------------------------------------------------------------
  it("useLabSectionsQuery returns sections", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const sections = [
      { id: 1, class_id: COURSE_ID, name: "Section A" },
      { id: 2, class_id: COURSE_ID, name: "Section B" }
    ];
    const supabase = createMockSupabase(sections);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useLabSectionsQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(sections);
    expect(supabase.from).toHaveBeenCalledWith("lab_sections");
  });

  // -----------------------------------------------------------------------
  // 2. useCalendarEventsQuery student filters office_hours
  // -----------------------------------------------------------------------
  it("useCalendarEventsQuery student filters office_hours", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const events = [{ id: 1, class_id: COURSE_ID, calendar_type: "office_hours", start_time: "2026-01-01T10:00:00Z" }];
    const supabase = createMockSupabase(events);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useCalendarEventsQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(events);
    expect(supabase.from).toHaveBeenCalledWith("calendar_events");

    // queryKey includes 'office_hours' for student
    const cached = qc.getQueryData(["course", COURSE_ID, "calendar_events", "office_hours"]);
    expect(cached).toEqual(events);
  });

  // -----------------------------------------------------------------------
  // 3. useLivePollsQuery returns polls
  // -----------------------------------------------------------------------
  it("useLivePollsQuery returns polls", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const polls = [
      { id: 1, class_id: COURSE_ID, question: "What is 2+2?", created_at: "2026-01-02T00:00:00Z" },
      { id: 2, class_id: COURSE_ID, question: "Favorite color?", created_at: "2026-01-01T00:00:00Z" }
    ];
    const supabase = createMockSupabase(polls);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false
    };

    const { result } = renderHook(() => useLivePollsQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(polls);
    expect(supabase.from).toHaveBeenCalledWith("live_polls");
  });

  // -----------------------------------------------------------------------
  // 4. useLabSectionInsert performs mutation
  // -----------------------------------------------------------------------
  it("useLabSectionInsert performs mutation", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const newSection = { id: 10, class_id: COURSE_ID, name: "New Section" };
    const supabase = createMockSupabase([newSection]);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: true
    };

    const { result } = renderHook(() => useLabSectionInsert(), {
      wrapper: createWrapper(qc)
    });

    // Trigger the mutation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result.current.mutate({ class_id: COURSE_ID, name: "New Section" } as any);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(supabase.from).toHaveBeenCalledWith("lab_sections");
  });

  // -----------------------------------------------------------------------
  // 5. useSurveysQuery returns surveys
  // -----------------------------------------------------------------------
  it("useSurveysQuery returns surveys", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const surveys = [
      { id: 1, class_id: COURSE_ID, title: "Midterm Feedback", deleted_at: null, created_at: "2026-01-02T00:00:00Z" },
      { id: 2, class_id: COURSE_ID, title: "End of Term", deleted_at: null, created_at: "2026-01-01T00:00:00Z" }
    ];
    const supabase = createMockSupabase(surveys);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: true
    };

    const { result } = renderHook(() => useSurveysQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(surveys);
    expect(supabase.from).toHaveBeenCalledWith("surveys");
  });
});
