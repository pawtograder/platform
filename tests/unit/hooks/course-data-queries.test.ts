import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { useProfilesQuery } from "@/hooks/course-data/useProfilesQuery";
import { useTagsQuery } from "@/hooks/course-data/useTagsQuery";
import { useAssignmentsQuery } from "@/hooks/course-data/useAssignmentsQuery";
import { CourseDataProvider } from "@/hooks/course-data/useCourseDataContext";
import type { CourseDataContextValue } from "@/hooks/course-data/useCourseDataContext";
import type { BroadcastMessage } from "@/lib/TableController";
import { setupMockBroadcastChannel, resetAllChannels } from "@/tests/mocks/MockBroadcastChannel";

// ---------------------------------------------------------------------------
// BroadcastChannel mock (jsdom has no native support)
// ---------------------------------------------------------------------------

setupMockBroadcastChannel();

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
  // Default: return empty arrays with no error for any table
  return {
    from: jest.fn((table: string) => {
      const response = responseMap?.[table] ?? { data: [], error: null };
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue(response)
            }),
            // For direct .eq().then() (no order)
            then: (resolve: (v: typeof response) => void) => Promise.resolve(response).then(resolve),
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue(response)
            })
          }),
          single: jest.fn().mockResolvedValue(response),
          in: jest.fn().mockResolvedValue(response)
        })
      };
    })
  };
}

function createContextValue(overrides: Partial<CourseDataContextValue> = {}): CourseDataContextValue {
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

function createWrapper(queryClient: QueryClient, ctxValue: CourseDataContextValue) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(CourseDataProvider, { value: ctxValue }, children)
    );
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("useProfilesQuery", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("returns profiles fetched from supabase", async () => {
    const qc = makeQueryClient();
    const mockProfiles = [
      { id: "p1", name: "Alice", class_id: 1 },
      { id: "p2", name: "Bob", class_id: 1 }
    ];
    const mockSupabase = createMockSupabase({
      profiles: { data: mockProfiles, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useProfilesQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockProfiles);
    expect(mockSupabase.from).toHaveBeenCalledWith("profiles");
  });

  it("uses initialData immediately without loading", () => {
    const qc = makeQueryClient();
    const initialProfiles = [{ id: "p1", name: "Pre-loaded", class_id: 1 }];
    const ctx = createContextValue({
      initialData: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        profiles: initialProfiles as any
      }
    });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useProfilesQuery(), { wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(initialProfiles);
  });
});

describe("useTagsQuery", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("returns tags fetched from supabase", async () => {
    const qc = makeQueryClient();
    const mockTags = [
      { id: 1, name: "instructor", profile_id: "p1", class_id: 1 },
      { id: 2, name: "student", profile_id: "p2", class_id: 1 }
    ];
    const mockSupabase = createMockSupabase({
      tags: { data: mockTags, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useTagsQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockTags);
    expect(mockSupabase.from).toHaveBeenCalledWith("tags");
  });
});

describe("useAssignmentsQuery", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("returns assignments fetched with ordering", async () => {
    const qc = makeQueryClient();
    const mockAssignments = [
      { id: 1, name: "HW1", class_id: 1, due_date: "2026-01-01" },
      { id: 2, name: "HW2", class_id: 1, due_date: "2026-02-01" }
    ];
    const mockSupabase = createMockSupabase({
      assignments: { data: mockAssignments, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useAssignmentsQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockAssignments);
    expect(mockSupabase.from).toHaveBeenCalledWith("assignments");
  });
});

describe("query key scoping", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("different courseIds produce different cache entries", async () => {
    const qc = makeQueryClient();
    const profiles1 = [{ id: "p1", name: "Course1 User", class_id: 1 }];
    const profiles2 = [{ id: "p2", name: "Course2 User", class_id: 2 }];

    const mockSupabase1 = createMockSupabase({
      profiles: { data: profiles1, error: null }
    });
    const mockSupabase2 = createMockSupabase({
      profiles: { data: profiles2, error: null }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx1 = createContextValue({ courseId: 1, supabase: mockSupabase1 as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx2 = createContextValue({ courseId: 2, supabase: mockSupabase2 as any });

    const wrapper1 = createWrapper(qc, ctx1);
    const wrapper2 = createWrapper(qc, ctx2);

    const { result: result1 } = renderHook(() => useProfilesQuery(), { wrapper: wrapper1 });
    const { result: result2 } = renderHook(() => useProfilesQuery(), { wrapper: wrapper2 });

    await waitFor(() => {
      expect(result1.current.isSuccess).toBe(true);
      expect(result2.current.isSuccess).toBe(true);
    });

    expect(result1.current.data).toEqual(profiles1);
    expect(result2.current.data).toEqual(profiles2);

    // Verify both cache entries exist independently
    expect(qc.getQueryData(["course", 1, "profiles"])).toEqual(profiles1);
    expect(qc.getQueryData(["course", 2, "profiles"])).toEqual(profiles2);
  });
});

describe("classRtc null handling", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("does not crash when classRtc is null", async () => {
    const qc = makeQueryClient();
    const mockProfiles = [{ id: "p1", name: "Alice", class_id: 1 }];
    const mockSupabase = createMockSupabase({
      profiles: { data: mockProfiles, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ classRtc: null, supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useProfilesQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockProfiles);
  });
});
