import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import React from "react";
import type { BroadcastMessage } from "@/lib/TableController";

import { useSubmissionCommentsQuery } from "@/hooks/submission-data/useSubmissionCommentsQuery";
import { useSubmissionFileCommentsQuery } from "@/hooks/submission-data/useSubmissionFileCommentsQuery";
import { useSubmissionArtifactCommentsQuery } from "@/hooks/submission-data/useSubmissionArtifactCommentsQuery";
import { useSubmissionReviewsQuery } from "@/hooks/submission-data/useSubmissionReviewsQuery";
import { useSubmissionRegradeRequestCommentsQuery } from "@/hooks/submission-data/useSubmissionRegradeRequestCommentsQuery";
import { useSubmissionFullQuery } from "@/hooks/submission-data/useSubmissionFullQuery";
import { useSubmissionCommentInsert } from "@/hooks/submission-data/useSubmissionCommentMutations";
import { SubmissionDataProvider } from "@/hooks/submission-data/useSubmissionDataContext";
import type { SubmissionDataContextValue } from "@/hooks/submission-data/useSubmissionDataContext";
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
  const insertedRow = { id: 99, body: "new comment", submission_id: 42 };
  return {
    from: jest.fn((table: string) => {
      const response = responseMap?.[table] ?? { data: [], error: null };
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue(response),
            order: jest.fn().mockResolvedValue(response),
            then: (resolve: (v: typeof response) => void) => Promise.resolve(response).then(resolve)
          }),
          single: jest.fn().mockResolvedValue(response),
          in: jest.fn().mockResolvedValue(response)
        }),
        insert: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue({ data: insertedRow, error: null })
          })
        }),
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: jest.fn().mockResolvedValue({ data: insertedRow, error: null })
            })
          })
        }),
        delete: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null })
        })
      };
    })
  };
}

function createContextValue(overrides: Partial<SubmissionDataContextValue> = {}): SubmissionDataContextValue {
  const { rtc } = createMockRtc();
  return {
    submissionId: 42,
    courseId: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: createMockSupabase() as any,
    classRtc: rtc,
    ...overrides
  };
}

function createWrapper(queryClient: QueryClient, ctxValue: SubmissionDataContextValue) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(SubmissionDataProvider, { value: ctxValue }, children)
    );
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("useSubmissionCommentsQuery", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("fetches comments for the submission", async () => {
    const qc = makeQueryClient();
    const mockComments = [
      { id: 1, body: "Nice work", submission_id: 42 },
      { id: 2, body: "Fix this", submission_id: 42 }
    ];
    const mockSupabase = createMockSupabase({
      submission_comments: { data: mockComments, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useSubmissionCommentsQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockComments);
    expect(mockSupabase.from).toHaveBeenCalledWith("submission_comments");
  });
});

describe("useSubmissionFileCommentsQuery", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("fetches file comments for the submission", async () => {
    const qc = makeQueryClient();
    const mockFileComments = [{ id: 10, body: "Line comment", submission_id: 42, submission_file_id: 5 }];
    const mockSupabase = createMockSupabase({
      submission_file_comments: { data: mockFileComments, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useSubmissionFileCommentsQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockFileComments);
    expect(mockSupabase.from).toHaveBeenCalledWith("submission_file_comments");
  });
});

describe("useSubmissionReviewsQuery", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("fetches reviews for the submission", async () => {
    const qc = makeQueryClient();
    const mockReviews = [{ id: 100, name: "Grading Review", submission_id: 42, rubric_id: 7 }];
    const mockSupabase = createMockSupabase({
      submission_reviews: { data: mockReviews, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useSubmissionReviewsQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockReviews);
    expect(mockSupabase.from).toHaveBeenCalledWith("submission_reviews");
  });
});

describe("useSubmissionFullQuery", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("fetches full submission with joined select", async () => {
    const qc = makeQueryClient();
    const mockSubmission = {
      id: 42,
      assignment_id: 5,
      submission_files: [{ id: 1, name: "main.py" }],
      grader_results: [],
      submission_artifacts: []
    };
    const mockSupabase = createMockSupabase({
      submissions: { data: mockSubmission, error: null }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useSubmissionFullQuery(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockSubmission);
    expect(mockSupabase.from).toHaveBeenCalledWith("submissions");
  });
});

describe("all hooks use scoped scope", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("submission-data hooks subscribe with scoped scope via classRtc", async () => {
    const qc = makeQueryClient();
    const { rtc } = createMockRtc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ classRtc: rtc as any });
    const wrapper = createWrapper(qc, ctx);

    // Render all five per-table hooks plus the full query
    renderHook(
      () => {
        useSubmissionCommentsQuery();
        useSubmissionFileCommentsQuery();
        useSubmissionArtifactCommentsQuery();
        useSubmissionReviewsQuery();
        useSubmissionRegradeRequestCommentsQuery();
        useSubmissionFullQuery();
      },
      { wrapper }
    );

    await waitFor(() => {
      // Each hook should register a subscription via subscribeToTable
      expect(rtc.subscribeToTable).toHaveBeenCalled();
    });

    // All six hooks subscribe to their respective tables
    const subscribedTables = rtc.subscribeToTable.mock.calls.map(
      (call: [string, (msg: BroadcastMessage) => void]) => call[0]
    );
    expect(subscribedTables).toContain("submission_comments");
    expect(subscribedTables).toContain("submission_file_comments");
    expect(subscribedTables).toContain("submission_artifact_comments");
    expect(subscribedTables).toContain("submission_reviews");
    expect(subscribedTables).toContain("submission_regrade_request_comments");
    expect(subscribedTables).toContain("submissions");
  });
});

describe("useSubmissionCommentInsert", () => {
  afterEach(() => {
    resetAllChannels();
    jest.clearAllMocks();
  });

  it("performs insert mutation", async () => {
    const qc = makeQueryClient();
    const insertedRow = { id: 99, body: "new comment", submission_id: 42 };
    const mockSupabase = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createContextValue({ supabase: mockSupabase as any });
    const wrapper = createWrapper(qc, ctx);

    const { result } = renderHook(() => useSubmissionCommentInsert(), { wrapper });

    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.current.mutate({ body: "new comment", submission_id: 42 } as any);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockSupabase.from).toHaveBeenCalledWith("submission_comments");
  });
});
