/**
 * Tests for previously untested course-data hooks:
 * - useClassSectionsQuery
 * - useClassStaffSettingsQuery
 * - useDiscordChannelsQuery
 * - useDiscordMessagesQuery
 * - useLabSectionLeadersQuery
 * - useLabSectionMeetingsQuery
 * - useSurveySeriesQuery
 * - useLabSectionLeaderInsert (mutation)
 * - useLabSectionMeetingInsert (mutation)
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockSupabase(data: any[] = [], error: any = null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function fluent(): any {
    const obj = {
      select: jest.fn(() => obj),
      eq: jest.fn(() => obj),
      order: jest.fn(() => obj),
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

function setCtx(overrides: Record<string, unknown> = {}) {
  const { rtc } = createMockRtc();
  const supabase = createMockSupabase((overrides.data as any[]) ?? []);
  mockCtxValue = {
    courseId: 1,
    userId: "user-123",
    profileId: "profile-123",
    supabase,
    classRtc: rtc,
    isStaff: overrides.isStaff ?? true,
    ...overrides,
    supabase: overrides.supabase ?? supabase
  };
  return { rtc, supabase: mockCtxValue.supabase };
}

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useClassSectionsQuery } from "@/hooks/course-data/useClassSectionsQuery";
import { useClassStaffSettingsQuery } from "@/hooks/course-data/useClassStaffSettingsQuery";
import { useDiscordChannelsQuery } from "@/hooks/course-data/useDiscordChannelsQuery";
import { useDiscordMessagesQuery } from "@/hooks/course-data/useDiscordMessagesQuery";
import { useLabSectionLeadersQuery } from "@/hooks/course-data/useLabSectionLeadersQuery";
import { useLabSectionMeetingsQuery } from "@/hooks/course-data/useLabSectionMeetingsQuery";
import { useSurveySeriesQuery } from "@/hooks/course-data/useSurveySeriesQuery";
import { useLabSectionLeaderInsert } from "@/hooks/course-data/useLabSectionLeadersMutation";
import { useLabSectionMeetingInsert } from "@/hooks/course-data/useLabSectionMeetingsMutation";

// ===========================================================================
// Tests
// ===========================================================================

describe("Untested course-data hooks", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("useClassSectionsQuery fetches class_sections", async () => {
    const rows = [{ id: 1, class_id: 1, name: "Section A" }];
    const { supabase } = setCtx({ data: rows });
    const qc = makeQueryClient();
    const { result } = renderHook(() => useClassSectionsQuery(), { wrapper: createWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(supabase.from).toHaveBeenCalledWith("class_sections");
  });

  it("useClassStaffSettingsQuery fetches staff settings (staff only)", async () => {
    const rows = [{ id: 1, class_id: 1, setting: "val" }];
    const { supabase } = setCtx({ data: rows, isStaff: true });
    const qc = makeQueryClient();
    const { result } = renderHook(() => useClassStaffSettingsQuery(), { wrapper: createWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(supabase.from).toHaveBeenCalledWith("class_staff_settings");
  });

  it("useClassStaffSettingsQuery is disabled for non-staff", () => {
    setCtx({ isStaff: false });
    const qc = makeQueryClient();
    const { result } = renderHook(() => useClassStaffSettingsQuery(), { wrapper: createWrapper(qc) });
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("useDiscordChannelsQuery fetches discord_channels", async () => {
    const rows = [{ id: 1, class_id: 1, name: "general" }];
    const { supabase } = setCtx({ data: rows, isStaff: true });
    const qc = makeQueryClient();
    const { result } = renderHook(() => useDiscordChannelsQuery(), { wrapper: createWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(supabase.from).toHaveBeenCalledWith("discord_channels");
  });

  it("useDiscordMessagesQuery fetches discord_messages", async () => {
    const rows = [{ id: 1, class_id: 1, content: "hello" }];
    const { supabase } = setCtx({ data: rows, isStaff: true });
    const qc = makeQueryClient();
    const { result } = renderHook(() => useDiscordMessagesQuery(), { wrapper: createWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(supabase.from).toHaveBeenCalledWith("discord_messages");
  });

  it("useLabSectionLeadersQuery fetches lab_section_leaders", async () => {
    const rows = [{ id: 1, class_id: 1, profile_id: "p1" }];
    const { supabase } = setCtx({ data: rows });
    const qc = makeQueryClient();
    const { result } = renderHook(() => useLabSectionLeadersQuery(), { wrapper: createWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(supabase.from).toHaveBeenCalledWith("lab_section_leaders");
  });

  it("useLabSectionMeetingsQuery fetches lab_section_meetings", async () => {
    const rows = [{ id: 1, class_id: 1, start_time: "2026-01-01T10:00:00Z" }];
    const { supabase } = setCtx({ data: rows });
    const qc = makeQueryClient();
    const { result } = renderHook(() => useLabSectionMeetingsQuery(), { wrapper: createWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(supabase.from).toHaveBeenCalledWith("lab_section_meetings");
  });

  it("useSurveySeriesQuery fetches survey_series", async () => {
    const rows = [{ id: 1, class_id: 1, name: "Weekly Checkin" }];
    const { supabase } = setCtx({ data: rows });
    const qc = makeQueryClient();
    const { result } = renderHook(() => useSurveySeriesQuery(), { wrapper: createWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(supabase.from).toHaveBeenCalledWith("survey_series");
  });

  it("useLabSectionLeaderInsert performs mutation", async () => {
    const newRow = { id: 10, class_id: 1, profile_id: "p1" };
    const { supabase } = setCtx({ data: [newRow] });
    const qc = makeQueryClient();
    const { result } = renderHook(() => useLabSectionLeaderInsert(), { wrapper: createWrapper(qc) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result.current.mutate({ class_id: 1, profile_id: "p1" } as any);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledWith("lab_section_leaders");
  });

  it("useLabSectionMeetingInsert performs mutation", async () => {
    const newRow = { id: 10, class_id: 1, start_time: "2026-01-01T10:00:00Z" };
    const { supabase } = setCtx({ data: [newRow] });
    const qc = makeQueryClient();
    const { result } = renderHook(() => useLabSectionMeetingInsert(), { wrapper: createWrapper(qc) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result.current.mutate({ class_id: 1, start_time: "2026-01-01T10:00:00Z" } as any);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledWith("lab_section_meetings");
  });
});
