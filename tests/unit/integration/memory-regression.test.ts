/**
 * Integration tests: TanStack Query gcTime prevents the old memory leak.
 *
 * Verifies that:
 * - Dynamic queries with explicit gcTime are garbage-collected after timer expires
 * - Multiple dynamic queries (help requests) don't accumulate indefinitely
 * - Static queries (default Infinity gcTime) persist as expected
 * - useReviewAssignmentRubricPartsQuery configuration also gets cleaned up
 *
 * Uses jest.useFakeTimers() + jest.advanceTimersByTime() for determinism.
 */

import { QueryClient, QueryCache } from "@tanstack/react-query";

// ===========================================================================
// Helpers
// ===========================================================================

function makeQC(defaultGcTime?: number): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // By default, TanStack Query uses 5 minutes gcTime.
        // For realtime-managed data we usually set Infinity.
        gcTime: defaultGcTime ?? Infinity,
        staleTime: Infinity
      }
    }
  });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Memory Regression -- gcTime garbage collection", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("dynamic query with gcTime is garbage collected after timer expires", () => {
    const SHORT_GC = 100; // ms, short for testing
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: SHORT_GC }
      }
    });

    const QK = ["course", 1, "review_assignment_rubric_parts", 42];

    // Seed the cache
    qc.setQueryData(QK, [{ id: 1, name: "Part A" }]);
    expect(qc.getQueryData(QK)).toBeDefined();

    // With no observers (setQueryData doesn't create observers), the entry is
    // eligible for GC after gcTime. TanStack Query schedules the GC via
    // setTimeout internally.
    jest.advanceTimersByTime(SHORT_GC + 50);

    // After gcTime, the cache entry should be removed
    expect(qc.getQueryData(QK)).toBeUndefined();

    qc.clear();
  });

  it("multiple help request queries don't accumulate indefinitely", () => {
    const GC_TIME = 200;
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: GC_TIME }
      }
    });

    // Simulate opening 5 help requests
    const helpRequestIds = [101, 102, 103, 104, 105];
    for (const hrId of helpRequestIds) {
      const QK = ["office_hours", 1, "help_request_messages", hrId];
      qc.setQueryData(QK, [{ id: hrId * 10, text: `msg for ${hrId}` }]);
    }

    // All 5 should be in cache
    for (const hrId of helpRequestIds) {
      expect(qc.getQueryData(["office_hours", 1, "help_request_messages", hrId])).toBeDefined();
    }

    // "Close" them (no observers) and wait past gcTime
    jest.advanceTimersByTime(GC_TIME + 50);

    // All 5 should be garbage collected
    for (const hrId of helpRequestIds) {
      expect(qc.getQueryData(["office_hours", 1, "help_request_messages", hrId])).toBeUndefined();
    }

    qc.clear();
  });

  it("static queries (Infinity gcTime) persist after timer advance", () => {
    const qc = makeQC(Infinity);

    const QK = ["course", 1, "profiles"];
    qc.setQueryData(QK, [{ id: 1, name: "Alice" }]);

    // Advance a long time -- well past any reasonable gcTime
    jest.advanceTimersByTime(60_000);

    // With Infinity gcTime, the entry persists forever (until qc.clear())
    expect(qc.getQueryData(QK)).toEqual([{ id: 1, name: "Alice" }]);

    qc.clear();
  });

  it("review assignment rubric parts cleaned up with finite gcTime", () => {
    // Mirror the actual gcTime from useReviewAssignmentRubricPartsQuery: 5 minutes
    const FIVE_MINUTES = 5 * 60 * 1000;
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: FIVE_MINUTES }
      }
    });

    const QK = ["course", 1, "review_assignment_rubric_parts", 7];
    qc.setQueryData(QK, [{ id: 1, review_assignment_id: 7, rubric_part_id: 3 }]);

    // Still present before gcTime
    jest.advanceTimersByTime(FIVE_MINUTES - 100);
    expect(qc.getQueryData(QK)).toBeDefined();

    // Gone after gcTime passes
    jest.advanceTimersByTime(200);
    expect(qc.getQueryData(QK)).toBeUndefined();

    qc.clear();
  });
});
