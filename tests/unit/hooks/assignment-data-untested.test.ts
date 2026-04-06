/**
 * Tests for previously untested assignment-data hooks:
 * - useAllReviewAssignmentsQuery
 * - useErrorPinRulesQuery
 * - useRegradeRequestsQuery
 * - useRubricCheckReferencesQuery
 * - useRubricCriteriaQuery
 * - useRubricPartsQuery
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { AssignmentDataProvider } from "@/hooks/assignment-data/useAssignmentDataContext";
import type { AssignmentDataContextValue } from "@/hooks/assignment-data/useAssignmentDataContext";
import type { BroadcastMessage } from "@/lib/TableController";
import { setupMockBroadcastChannel, resetAllChannels } from "@/tests/mocks/MockBroadcastChannel";

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
    defaultOptions: { queries: { retry: false } }
  });
}

function createMockRtc() {
  const subscribers = new Map<string, Set<(msg: BroadcastMessage) => void>>();
  const rtc = {
    subscribeToTable: jest.fn((table: string, cb: (msg: BroadcastMessage) => void) => {
      if (!subscribers.has(table)) subscribers.set(table, new Set());
      subscribers.get(table)!.add(cb);
      return () => { subscribers.get(table)?.delete(cb); };
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
    isStaff: true,
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useAllReviewAssignmentsQuery } from "@/hooks/assignment-data/useAllReviewAssignmentsQuery";
import { useErrorPinRulesQuery } from "@/hooks/assignment-data/useErrorPinRulesQuery";
import { useRegradeRequestsQuery } from "@/hooks/assignment-data/useRegradeRequestsQuery";
import { useRubricCheckReferencesQuery } from "@/hooks/assignment-data/useRubricCheckReferencesQuery";
import { useRubricCriteriaQuery } from "@/hooks/assignment-data/useRubricCriteriaQuery";
import { useRubricPartsQuery } from "@/hooks/assignment-data/useRubricPartsQuery";

// ===========================================================================
// Tests
// ===========================================================================

describe("Untested assignment-data hooks", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("useAllReviewAssignmentsQuery fetches review_assignments (staff only)", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, assignment_id: 10, assignee_profile_id: "p1" }];
    const mockSupabase = createMockSupabase({ review_assignments: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any, isStaff: true });
    const { result } = renderHook(() => useAllReviewAssignmentsQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("review_assignments");
  });

  it("useAllReviewAssignmentsQuery is disabled for non-staff", () => {
    const qc = makeQueryClient();
    const ctx = createContextValue({ isStaff: false });
    const { result } = renderHook(() => useAllReviewAssignmentsQuery(), { wrapper: createWrapper(qc, ctx) });
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("useErrorPinRulesQuery fetches error_pin_rules", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, error_pin_id: 5, regex: ".*" }];
    const mockSupabase = createMockSupabase({ error_pin_rules: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useErrorPinRulesQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("error_pin_rules");
  });

  it("useRegradeRequestsQuery fetches submission_regrade_requests", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, assignment_id: 10, status: "pending" }];
    const mockSupabase = createMockSupabase({ submission_regrade_requests: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useRegradeRequestsQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("submission_regrade_requests");
  });

  it("useRubricCheckReferencesQuery fetches rubric_check_references", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, assignment_id: 10, rubric_check_id: 3 }];
    const mockSupabase = createMockSupabase({ rubric_check_references: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useRubricCheckReferencesQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("rubric_check_references");
  });

  it("useRubricCriteriaQuery fetches rubric_criteria", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, assignment_id: 10, name: "Code Style" }];
    const mockSupabase = createMockSupabase({ rubric_criteria: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useRubricCriteriaQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("rubric_criteria");
  });

  it("useRubricPartsQuery fetches rubric_parts", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, assignment_id: 10, name: "Part A" }];
    const mockSupabase = createMockSupabase({ rubric_parts: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useRubricPartsQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("rubric_parts");
  });
});
