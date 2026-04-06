/**
 * Integration tests: cross-tab sync for scoped (per-submission) channels.
 *
 * Verifies that:
 * - processRealtimeBatch + RealtimeDiffChannel.applyDiff work end-to-end
 *   for INSERT and DELETE on scoped query keys
 * - Different scoped channels (different submissionIds) don't interfere
 * - Rapid consecutive messages all apply correctly (chat-like pattern)
 */

import { QueryClient } from "@tanstack/react-query";
import { setupMockBroadcastChannel, resetAllChannels } from "@/tests/mocks/MockBroadcastChannel";
import { RealtimeDiffChannel } from "@/lib/cross-tab/RealtimeDiffChannel";
import { processRealtimeBatch, BatchHandlerConfig } from "@/lib/cross-tab/createRealtimeBatchHandler";
import type { BroadcastMessage } from "@/lib/TableController";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

setupMockBroadcastChannel();

function makeQC(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
}

function mockSupabase() {
  return {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: [], error: null })
      })
    })
  };
}

function makeBroadcast(
  overrides: Partial<BroadcastMessage> & { operation: string; table: string }
): BroadcastMessage {
  return {
    type: "table_change",
    class_id: 1,
    timestamp: new Date().toISOString(),
    ...overrides
  } as BroadcastMessage;
}

function baseConfig(qc: QueryClient, overrides?: Partial<BatchHandlerConfig>): BatchHandlerConfig {
  return {
    table: "submission_comments",
    queryKey: ["submission", 1, "comments"],
    queryClient: qc,
    supabase: mockSupabase(),
    tabId: "tab-a",
    ...overrides
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Scoped Cross-Tab Sync (submissions)", () => {
  beforeEach(() => {
    resetAllChannels();
  });

  afterEach(() => {
    resetAllChannels();
  });

  it("scoped INSERT propagates from Tab A to Tab B", async () => {
    const qcA = makeQC();
    const qcB = makeQC();
    const QK = ["submission", 1, "comments"] as const;

    qcA.setQueryData(QK, [{ id: 1, text: "first" }]);
    qcB.setQueryData(QK, [{ id: 1, text: "first" }]);

    const dcA = new RealtimeDiffChannel("tab-a", { channelName: "scoped-insert" });
    const dcB = new RealtimeDiffChannel("tab-b", { channelName: "scoped-insert" });
    dcB.onDiff((d) => RealtimeDiffChannel.applyDiff(qcB, d));

    const result = await processRealtimeBatch(
      [makeBroadcast({ operation: "INSERT", table: "submission_comments", data: { id: 2, text: "second" } })],
      baseConfig(qcA, { queryKey: [...QK], tabId: "tab-a" })
    );

    if (result.cacheDiff) dcA.broadcastDiff(result.cacheDiff);

    expect(qcA.getQueryData(QK)).toEqual([
      { id: 1, text: "first" },
      { id: 2, text: "second" }
    ]);
    expect(qcB.getQueryData(QK)).toEqual(qcA.getQueryData(QK));

    dcA.close();
    dcB.close();
  });

  it("scoped DELETE propagates from Tab A to Tab B", async () => {
    const qcA = makeQC();
    const qcB = makeQC();
    const QK = ["submission", 1, "comments"] as const;

    const initial = [
      { id: 1, text: "keep" },
      { id: 2, text: "remove" }
    ];
    qcA.setQueryData(QK, [...initial]);
    qcB.setQueryData(QK, [...initial]);

    const dcA = new RealtimeDiffChannel("tab-a", { channelName: "scoped-delete" });
    const dcB = new RealtimeDiffChannel("tab-b", { channelName: "scoped-delete" });
    dcB.onDiff((d) => RealtimeDiffChannel.applyDiff(qcB, d));

    const result = await processRealtimeBatch(
      [makeBroadcast({ operation: "DELETE", table: "submission_comments", row_id: 2 })],
      baseConfig(qcA, { queryKey: [...QK], tabId: "tab-a" })
    );

    if (result.cacheDiff) dcA.broadcastDiff(result.cacheDiff);

    const expected = [{ id: 1, text: "keep" }];
    expect(qcA.getQueryData(QK)).toEqual(expected);
    expect(qcB.getQueryData(QK)).toEqual(expected);

    dcA.close();
    dcB.close();
  });

  it("scoped channels with different submissionIds don't interfere", async () => {
    const qcA = makeQC();
    const qcB = makeQC();
    const QK1 = ["submission", 1, "comments"] as const;
    const QK2 = ["submission", 2, "comments"] as const;

    qcA.setQueryData(QK1, [{ id: 10, text: "sub1" }]);
    qcB.setQueryData(QK2, [{ id: 20, text: "sub2" }]);

    // Tab A processes an INSERT scoped to submission 1
    const result = await processRealtimeBatch(
      [makeBroadcast({ operation: "INSERT", table: "submission_comments", data: { id: 11, text: "new-in-sub1" } })],
      baseConfig(qcA, { queryKey: [...QK1], tabId: "tab-a" })
    );

    // The diff's queryKey is QK1 -- applying it to Tab B's QK2 cache should be a no-op
    // because the queryKey won't match.
    if (result.cacheDiff) {
      RealtimeDiffChannel.applyDiff(qcB, result.cacheDiff);
    }

    // Tab A's submission 1 cache has the new row
    expect(qcA.getQueryData(QK1)).toEqual([
      { id: 10, text: "sub1" },
      { id: 11, text: "new-in-sub1" }
    ]);

    // Tab B's submission 2 cache is unchanged -- the diff targeted QK1, so it
    // either created a QK1 entry on qcB or left QK2 alone. Either way QK2 is untouched.
    expect(qcB.getQueryData(QK2)).toEqual([{ id: 20, text: "sub2" }]);

    dcCleanup();

    function dcCleanup() {
      // No diff channels created for this test (we used applyDiff directly)
    }
  });

  it("rapid scoped updates (chat-like) all apply correctly", async () => {
    const qcA = makeQC();
    const qcB = makeQC();
    const QK = ["submission", 1, "chat"] as const;

    qcA.setQueryData(QK, []);
    qcB.setQueryData(QK, []);

    const dcA = new RealtimeDiffChannel("tab-a", { channelName: "rapid-chat" });
    const dcB = new RealtimeDiffChannel("tab-b", { channelName: "rapid-chat" });
    dcB.onDiff((d) => RealtimeDiffChannel.applyDiff(qcB, d));

    // Fire 10 rapid INSERT messages
    for (let i = 1; i <= 10; i++) {
      const result = await processRealtimeBatch(
        [
          makeBroadcast({
            operation: "INSERT",
            table: "submission_comments",
            data: { id: i, text: `msg-${i}` }
          })
        ],
        baseConfig(qcA, { queryKey: [...QK], tabId: "tab-a" })
      );

      if (result.cacheDiff) dcA.broadcastDiff(result.cacheDiff);
    }

    const leaderData = qcA.getQueryData(QK) as any[];
    const followerData = qcB.getQueryData(QK) as any[];

    expect(leaderData).toHaveLength(10);
    expect(followerData).toHaveLength(10);

    // Verify ordering and content
    for (let i = 1; i <= 10; i++) {
      expect(leaderData[i - 1]).toEqual({ id: i, text: `msg-${i}` });
    }
    expect(followerData).toEqual(leaderData);

    dcA.close();
    dcB.close();
  });
});
