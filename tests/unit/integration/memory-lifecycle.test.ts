/**
 * Verify TanStack Query gcTime and enabled patterns for dynamic hooks.
 *
 * These tests import the actual hook source files and inspect the config
 * they pass to useSupabaseRealtimeQuery, verifying:
 * - Per-request hooks set gcTime for auto-eviction (fixes memory leaks)
 * - Dynamic hooks with null params disable the query
 */

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";

// ---------------------------------------------------------------------------
// Mock useSupabaseRealtimeQuery to capture config
// ---------------------------------------------------------------------------

jest.mock("@/hooks/useSupabaseRealtimeQuery", () => ({
  useSupabaseRealtimeQuery: jest.fn(() => ({
    data: undefined,
    isLoading: false,
    error: null
  }))
}));

const mockedUseSupabaseRealtimeQuery = useSupabaseRealtimeQuery as jest.MockedFunction<typeof useSupabaseRealtimeQuery>;

// ---------------------------------------------------------------------------
// Mock context providers so hooks can run without React rendering
// ---------------------------------------------------------------------------

jest.mock("@/hooks/office-hours-data/useOfficeHoursDataContext", () => ({
  useOfficeHoursDataContext: () => ({
    classId: 1,
    supabase: {},
    classRtc: null,
    officeHoursRtc: null
  })
}));

jest.mock("@/hooks/assignment-data/useAssignmentDataContext", () => ({
  useAssignmentDataContext: () => ({
    assignmentId: 10,
    courseId: 1,
    profileId: null,
    supabase: {},
    classRtc: null,
    isStaff: false
  })
}));

// We need to use require() inside each test to ensure the mock is active

// ===========================================================================
// Tests
// ===========================================================================

describe("Memory Lifecycle -- gcTime", () => {
  beforeEach(() => {
    mockedUseSupabaseRealtimeQuery.mockClear();
  });

  it("useHelpRequestMessagesQuery configures gcTime for auto-eviction", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useHelpRequestMessagesQuery } = require("@/hooks/office-hours-data/useHelpRequestMessagesQuery");
    useHelpRequestMessagesQuery(42);

    expect(mockedUseSupabaseRealtimeQuery).toHaveBeenCalledTimes(1);
    const config = mockedUseSupabaseRealtimeQuery.mock.calls[0][0];
    expect(config.gcTime).toBe(5 * 60 * 1000); // 5 minutes
  });

  it("useHelpRequestReadReceiptsQuery configures gcTime for auto-eviction", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useHelpRequestReadReceiptsQuery } = require("@/hooks/office-hours-data/useHelpRequestReadReceiptsQuery");
    useHelpRequestReadReceiptsQuery(42);

    expect(mockedUseSupabaseRealtimeQuery).toHaveBeenCalledTimes(1);
    const config = mockedUseSupabaseRealtimeQuery.mock.calls[0][0];
    expect(config.gcTime).toBe(5 * 60 * 1000);
  });

  it("useReviewAssignmentRubricPartsQuery configures gcTime for auto-eviction", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      useReviewAssignmentRubricPartsQuery
    } = require("@/hooks/assignment-data/useReviewAssignmentRubricPartsQuery");
    useReviewAssignmentRubricPartsQuery(10);

    expect(mockedUseSupabaseRealtimeQuery).toHaveBeenCalledTimes(1);
    const config = mockedUseSupabaseRealtimeQuery.mock.calls[0][0];
    expect(config.gcTime).toBe(5 * 60 * 1000);
  });
});

describe("Memory Lifecycle -- disabled hooks", () => {
  beforeEach(() => {
    mockedUseSupabaseRealtimeQuery.mockClear();
  });

  it("useHelpRequestMessagesQuery with null id sets enabled=false", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useHelpRequestMessagesQuery } = require("@/hooks/office-hours-data/useHelpRequestMessagesQuery");
    useHelpRequestMessagesQuery(null);

    expect(mockedUseSupabaseRealtimeQuery).toHaveBeenCalledTimes(1);
    const config = mockedUseSupabaseRealtimeQuery.mock.calls[0][0];
    expect(config.enabled).toBe(false);
  });

  it("useHelpRequestReadReceiptsQuery with null id sets enabled=false", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useHelpRequestReadReceiptsQuery } = require("@/hooks/office-hours-data/useHelpRequestReadReceiptsQuery");
    useHelpRequestReadReceiptsQuery(null);

    expect(mockedUseSupabaseRealtimeQuery).toHaveBeenCalledTimes(1);
    const config = mockedUseSupabaseRealtimeQuery.mock.calls[0][0];
    expect(config.enabled).toBe(false);
  });

  it("useReviewAssignmentRubricPartsQuery with null id sets enabled=false", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      useReviewAssignmentRubricPartsQuery
    } = require("@/hooks/assignment-data/useReviewAssignmentRubricPartsQuery");
    useReviewAssignmentRubricPartsQuery(null);

    expect(mockedUseSupabaseRealtimeQuery).toHaveBeenCalledTimes(1);
    const config = mockedUseSupabaseRealtimeQuery.mock.calls[0][0];
    expect(config.enabled).toBe(false);
  });
});
