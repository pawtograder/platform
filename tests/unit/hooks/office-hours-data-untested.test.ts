/**
 * Tests for previously untested office-hours-data hooks:
 * - useHelpQueueAssignmentsQuery
 * - useHelpRequestFeedbackQuery
 * - useHelpRequestFileReferencesQuery
 * - useHelpRequestModerationQuery
 * - useHelpRequestStudentsQuery
 * - useHelpRequestTemplatesQuery
 * - useStudentHelpActivityQuery
 * - useStudentKarmaNotesQuery
 * - useVideoMeetingSessionsQuery
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { OfficeHoursDataProvider } from "@/hooks/office-hours-data/useOfficeHoursDataContext";
import type { OfficeHoursDataContextValue } from "@/hooks/office-hours-data/useOfficeHoursDataContext";
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
              then: (resolve: (v: typeof response) => void) => Promise.resolve(response).then(resolve),
              order: jest.fn().mockReturnValue({
                order: jest.fn().mockResolvedValue(response)
              })
            }),
            order: jest.fn().mockReturnValue({
              order: jest.fn().mockResolvedValue(response)
            }),
            then: (resolve: (v: typeof response) => void) => Promise.resolve(response).then(resolve)
          }),
          single: jest.fn().mockResolvedValue(response),
          in: jest.fn().mockResolvedValue(response)
        })
      };
    })
  };
}

function createContextValue(overrides: Partial<OfficeHoursDataContextValue> = {}): OfficeHoursDataContextValue {
  const { rtc } = createMockRtc();
  return {
    classId: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: createMockSupabase() as any,
    classRtc: rtc,
    officeHoursRtc: null,
    ...overrides
  };
}

function createWrapper(queryClient: QueryClient, ctxValue: OfficeHoursDataContextValue) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(OfficeHoursDataProvider, { value: ctxValue }, children)
    );
  };
}

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useHelpQueueAssignmentsQuery } from "@/hooks/office-hours-data/useHelpQueueAssignmentsQuery";
import { useHelpRequestFeedbackQuery } from "@/hooks/office-hours-data/useHelpRequestFeedbackQuery";
import { useHelpRequestFileReferencesQuery } from "@/hooks/office-hours-data/useHelpRequestFileReferencesQuery";
import { useHelpRequestModerationQuery } from "@/hooks/office-hours-data/useHelpRequestModerationQuery";
import { useHelpRequestStudentsQuery } from "@/hooks/office-hours-data/useHelpRequestStudentsQuery";
import { useHelpRequestTemplatesQuery } from "@/hooks/office-hours-data/useHelpRequestTemplatesQuery";
import { useStudentHelpActivityQuery } from "@/hooks/office-hours-data/useStudentHelpActivityQuery";
import { useStudentKarmaNotesQuery } from "@/hooks/office-hours-data/useStudentKarmaNotesQuery";
import { useVideoMeetingSessionsQuery } from "@/hooks/office-hours-data/useVideoMeetingSessionsQuery";

// ===========================================================================
// Tests
// ===========================================================================

describe("Untested office-hours-data hooks", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("useHelpQueueAssignmentsQuery fetches help_queue_assignments", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, class_id: 1, help_queue_id: 5, profile_id: "p1" }];
    const mockSupabase = createMockSupabase({ help_queue_assignments: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useHelpQueueAssignmentsQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("help_queue_assignments");
  });

  it("useHelpRequestFeedbackQuery fetches help_request_feedback", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, class_id: 1, rating: 5 }];
    const mockSupabase = createMockSupabase({ help_request_feedback: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useHelpRequestFeedbackQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("help_request_feedback");
  });

  it("useHelpRequestFileReferencesQuery fetches help_request_file_references", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, class_id: 1, file_path: "main.py" }];
    const mockSupabase = createMockSupabase({ help_request_file_references: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useHelpRequestFileReferencesQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("help_request_file_references");
  });

  it("useHelpRequestModerationQuery fetches help_request_moderation", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, class_id: 1, action: "warn" }];
    const mockSupabase = createMockSupabase({ help_request_moderation: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useHelpRequestModerationQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("help_request_moderation");
  });

  it("useHelpRequestStudentsQuery fetches help_request_students", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, class_id: 1, profile_id: "p1" }];
    const mockSupabase = createMockSupabase({ help_request_students: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useHelpRequestStudentsQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("help_request_students");
  });

  it("useHelpRequestTemplatesQuery fetches help_request_templates", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, class_id: 1, title: "Bug Report" }];
    const mockSupabase = createMockSupabase({ help_request_templates: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useHelpRequestTemplatesQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("help_request_templates");
  });

  it("useStudentHelpActivityQuery fetches student_help_activity", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, class_id: 1, profile_id: "p1", total_requests: 5 }];
    const mockSupabase = createMockSupabase({ student_help_activity: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useStudentHelpActivityQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("student_help_activity");
  });

  it("useStudentKarmaNotesQuery fetches student_karma_notes", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, class_id: 1, note: "Helpful student" }];
    const mockSupabase = createMockSupabase({ student_karma_notes: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useStudentKarmaNotesQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("student_karma_notes");
  });

  it("useVideoMeetingSessionsQuery fetches video_meeting_sessions", async () => {
    const qc = makeQueryClient();
    const rows = [{ id: 1, class_id: 1, meeting_url: "https://meet.example.com" }];
    const mockSupabase = createMockSupabase({ video_meeting_sessions: { data: rows, error: null } });
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const { result } = renderHook(() => useVideoMeetingSessionsQuery(), { wrapper: createWrapper(qc, ctx) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockSupabase.from).toHaveBeenCalledWith("video_meeting_sessions");
  });
});
