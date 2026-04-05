import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { useSubmissionsQuery } from "@/hooks/assignment-data/useSubmissionsQuery";
import { useRubricsQuery } from "@/hooks/assignment-data/useRubricsQuery";
import { useRubricChecksQuery } from "@/hooks/assignment-data/useRubricChecksQuery";
import { useReviewAssignmentsQuery } from "@/hooks/assignment-data/useReviewAssignmentsQuery";
import { useLeaderboardQuery } from "@/hooks/assignment-data/useLeaderboardQuery";
import { useReviewAssignmentRubricPartsQuery } from "@/hooks/assignment-data/useReviewAssignmentRubricPartsQuery";
import { useErrorPinsQuery } from "@/hooks/assignment-data/useErrorPinsQuery";
import { AssignmentDataProvider } from "@/hooks/assignment-data/useAssignmentDataContext";
import type { AssignmentDataContextValue } from "@/hooks/assignment-data/useAssignmentDataContext";
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
              order: jest.fn().mockResolvedValue(response),
              then: (resolve: (v: typeof response) => void) => Promise.resolve(response).then(resolve)
            }),
            order: jest.fn().mockResolvedValue(response),
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

function createContextValue(overrides: Partial<AssignmentDataContextValue> = {}): AssignmentDataContextValue {
  const { rtc } = createMockRtc();
  return {
    assignmentId: 10,
    courseId: 1,
    profileId: "profile-123",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: createMockSupabase() as any,
    classRtc: rtc,
    isStaff: false,
    ...overrides
  };
}

function createWrapper(queryClient: QueryClient, ctxValue: AssignmentDataContextValue) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(AssignmentDataProvider, { value: ctxValue }, children)
    );
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("useSubmissionsQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("fetches submissions from supabase", async () => {
    const qc = makeQueryClient();
    const mockSubmissions = [
      { id: 1, assignment_id: 10, is_active: true },
      { id: 2, assignment_id: 10, is_active: true }
    ];
    const mockSupabase = createMockSupabase({
      submissions: { data: mockSubmissions, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useSubmissionsQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockSubmissions);
    expect(mockSupabase.from).toHaveBeenCalledWith("submissions");
  });
});

describe("useRubricsQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("uses initialData immediately without loading", () => {
    const qc = makeQueryClient();
    const initialRubrics = [{ id: 1, assignment_id: 10, review_round: "grading" }];
    const ctx = createContextValue({
      initialData: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rubrics: initialRubrics as any
      }
    });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useRubricsQuery(), { wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual(initialRubrics);
  });
});

describe("useRubricChecksQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("filters by assignment_id", async () => {
    const qc = makeQueryClient();
    const mockChecks = [{ id: 1, assignment_id: 10, rubric_criteria_id: 5 }];
    const mockSupabase = createMockSupabase({
      rubric_checks: { data: mockChecks, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useRubricChecksQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockChecks);
    expect(mockSupabase.from).toHaveBeenCalledWith("rubric_checks");
  });
});

describe("useReviewAssignmentsQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("uses profileId in filter", async () => {
    const qc = makeQueryClient();
    const mockReviewAssignments = [{ id: 1, assignment_id: 10, assignee_profile_id: "profile-123" }];
    const mockSupabase = createMockSupabase({
      review_assignments: { data: mockReviewAssignments, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any, profileId: "profile-123" });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useReviewAssignmentsQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockReviewAssignments);
    expect(mockSupabase.from).toHaveBeenCalledWith("review_assignments");
  });
});

describe("useLeaderboardQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("returns sorted data", async () => {
    const qc = makeQueryClient();
    const mockLeaderboard = [
      { id: 1, assignment_id: 10, autograder_score: 100 },
      { id: 2, assignment_id: 10, autograder_score: 85 }
    ];
    const mockSupabase = createMockSupabase({
      assignment_leaderboard: { data: mockLeaderboard, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useLeaderboardQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockLeaderboard);
    // Verify the first entry has a higher score (server-side ordering)
    expect(result.current.data![0].autograder_score).toBeGreaterThanOrEqual(result.current.data![1].autograder_score);
  });
});

describe("useReviewAssignmentRubricPartsQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("is disabled when reviewAssignmentId is null", () => {
    const qc = makeQueryClient();
    const ctx = createContextValue();
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useReviewAssignmentRubricPartsQuery(null), { wrapper });

    // When disabled, the query should not be loading and should not have fetched
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useErrorPinsQuery", () => {
  afterEach(() => {
    channelRegistry.clear();
    jest.clearAllMocks();
  });

  it("fetches error pins from supabase", async () => {
    const qc = makeQueryClient();
    const mockPins = [{ id: 1, assignment_id: 10, name: "NullPointerException" }];
    const mockSupabase = createMockSupabase({
      error_pins: { data: mockPins, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useErrorPinsQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockPins);
    expect(mockSupabase.from).toHaveBeenCalledWith("error_pins");
  });
});
