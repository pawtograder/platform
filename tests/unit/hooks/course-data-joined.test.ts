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

import { useUserRolesQuery } from "@/hooks/course-data/useUserRolesQuery";
import { useAssignmentGroupsQuery } from "@/hooks/course-data/useAssignmentGroupsQuery";

// ===========================================================================
// Tests
// ===========================================================================

describe("Phase 3 Batch 3 — joined-select query hooks", () => {
  const COURSE_ID = 42;
  const USER_ID = "user-abc-123";
  const PROFILE_ID = "profile-xyz";

  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. useUserRolesQuery — staff fetches all roles
  // -----------------------------------------------------------------------
  it("useUserRolesQuery staff fetches all roles (no user_id filter)", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const roles = [
      {
        id: 1,
        class_id: COURSE_ID,
        user_id: "u1",
        role: "instructor",
        profiles: { id: "p1", name: "Alice" },
        users: { id: "u1" }
      },
      {
        id: 2,
        class_id: COURSE_ID,
        user_id: "u2",
        role: "student",
        profiles: { id: "p2", name: "Bob" },
        users: { id: "u2" }
      }
    ];
    const supabase = createMockSupabase(roles);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: true,
      initialData: undefined
    };

    const { result } = renderHook(() => useUserRolesQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(roles);
    expect(supabase.from).toHaveBeenCalledWith("user_roles");

    // Staff queryKey uses "all"
    const cached = qc.getQueryData(["course", COURSE_ID, "user_roles", "all"]);
    expect(cached).toEqual(roles);
  });

  // -----------------------------------------------------------------------
  // 2. useUserRolesQuery — student fetches own role
  // -----------------------------------------------------------------------
  it("useUserRolesQuery student fetches own role (with user_id filter)", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const roles = [
      {
        id: 2,
        class_id: COURSE_ID,
        user_id: USER_ID,
        role: "student",
        profiles: { id: "p2", name: "Me" },
        users: { id: USER_ID }
      }
    ];
    const supabase = createMockSupabase(roles);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false,
      initialData: undefined
    };

    const { result } = renderHook(() => useUserRolesQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(roles);

    // Student queryKey uses userId
    const cached = qc.getQueryData(["course", COURSE_ID, "user_roles", USER_ID]);
    expect(cached).toEqual(roles);
  });

  // -----------------------------------------------------------------------
  // 3. useUserRolesQuery uses initialData
  // -----------------------------------------------------------------------
  it("useUserRolesQuery uses initialData — data available immediately", () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const roles = [
      {
        id: 1,
        class_id: COURSE_ID,
        user_id: "u1",
        role: "instructor",
        profiles: { id: "p1", name: "Alice" },
        users: { id: "u1" }
      }
    ];
    const supabase = createMockSupabase();

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: true,
      initialData: { userRolesWithProfiles: roles }
    };

    const { result } = renderHook(() => useUserRolesQuery(), {
      wrapper: createWrapper(qc)
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(roles);
  });

  // -----------------------------------------------------------------------
  // 4. useAssignmentGroupsQuery fetches groups with members
  // -----------------------------------------------------------------------
  it("useAssignmentGroupsQuery fetches groups with nested members", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const groups = [
      {
        id: 10,
        class_id: COURSE_ID,
        assignment_groups_members: [
          { id: 100, assignment_group_id: 10, profile_id: "p1" },
          { id: 101, assignment_group_id: 10, profile_id: "p2" }
        ],
        mentor: { name: "Prof. X" }
      },
      {
        id: 11,
        class_id: COURSE_ID,
        assignment_groups_members: [],
        mentor: null
      }
    ];
    const supabase = createMockSupabase(groups);

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false,
      initialData: undefined
    };

    const { result } = renderHook(() => useAssignmentGroupsQuery(), {
      wrapper: createWrapper(qc)
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(groups);
    expect(supabase.from).toHaveBeenCalledWith("assignment_groups");

    // Verify nested members came through
    expect(result.current.data![0].assignment_groups_members).toHaveLength(2);
    expect(result.current.data![1].mentor).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 5. useAssignmentGroupsQuery uses initialData
  // -----------------------------------------------------------------------
  it("useAssignmentGroupsQuery uses initialData — data available immediately", () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    const groups = [
      {
        id: 10,
        class_id: COURSE_ID,
        assignment_groups_members: [{ id: 100, assignment_group_id: 10, profile_id: "p1" }],
        mentor: { name: "Mentor A" }
      }
    ];
    const supabase = createMockSupabase();

    mockCtxValue = {
      courseId: COURSE_ID,
      userId: USER_ID,
      profileId: PROFILE_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      classRtc: rtc,
      isStaff: false,
      initialData: { assignmentGroupsWithMembers: groups }
    };

    const { result } = renderHook(() => useAssignmentGroupsQuery(), {
      wrapper: createWrapper(qc)
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(groups);
  });
});
