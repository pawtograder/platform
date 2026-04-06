import { QueryClient } from "@tanstack/react-query";
import { RealtimeDiffChannel, CacheDiff } from "@/lib/cross-tab/RealtimeDiffChannel";
import { setupMockBroadcastChannel, resetAllChannels } from "@/tests/mocks/MockBroadcastChannel";

// ---------------------------------------------------------------------------
// BroadcastChannel mock (jsdom has no native support)
// ---------------------------------------------------------------------------

beforeAll(() => {
  setupMockBroadcastChannel();
});

afterEach(() => {
  resetAllChannels();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiff(source: string, overrides?: Partial<CacheDiff>): CacheDiff {
  return {
    queryKey: ["students"],
    operations: [{ type: "upsert", rows: [{ id: 1, name: "Alice" }] }],
    source,
    timestamp: Date.now(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RealtimeDiffChannel", () => {
  it("basic upsert sync — Tab A broadcasts, Tab B receives", () => {
    const chanA = new RealtimeDiffChannel("tab-a");
    const chanB = new RealtimeDiffChannel("tab-b");
    const received: CacheDiff[] = [];
    chanB.onDiff((d) => received.push(d));

    const diff = makeDiff("tab-a");
    chanA.broadcastDiff(diff);

    expect(received).toHaveLength(1);
    expect(received[0].operations[0].rows[0]).toEqual({ id: 1, name: "Alice" });

    chanA.close();
    chanB.close();
  });

  it("delete sync — Tab A broadcasts remove, Tab B receives", () => {
    const chanA = new RealtimeDiffChannel("tab-a");
    const chanB = new RealtimeDiffChannel("tab-b");
    const received: CacheDiff[] = [];
    chanB.onDiff((d) => received.push(d));

    const diff = makeDiff("tab-a", {
      operations: [{ type: "remove", rows: [{ id: 42 }] }]
    });
    chanA.broadcastDiff(diff);

    expect(received).toHaveLength(1);
    expect(received[0].operations[0].type).toBe("remove");

    chanA.close();
    chanB.close();
  });

  it("applyDiff upsert — creates and updates rows in cache", () => {
    const qc = new QueryClient();
    const key = ["items"];
    qc.setQueryData(key, [
      { id: 1, value: "old" },
      { id: 2, value: "keep" }
    ]);

    RealtimeDiffChannel.applyDiff(qc, {
      queryKey: key,
      operations: [
        {
          type: "upsert",
          rows: [
            { id: 1, value: "updated" },
            { id: 3, value: "new" }
          ]
        }
      ],
      source: "tab-x",
      timestamp: Date.now()
    });

    const data = qc.getQueryData<Record<string, unknown>[]>(key);
    expect(data).toHaveLength(3);
    // Existing item updated in place (position preserved)
    expect(data![0]).toEqual({ id: 1, value: "updated" });
    // Untouched item stays
    expect(data![1]).toEqual({ id: 2, value: "keep" });
    // New item appended
    expect(data![2]).toEqual({ id: 3, value: "new" });
  });

  it("applyDiff remove — removes rows by id from cache", () => {
    const qc = new QueryClient();
    const key = ["items"];
    qc.setQueryData(key, [
      { id: "a", v: 1 },
      { id: "b", v: 2 },
      { id: "c", v: 3 }
    ]);

    RealtimeDiffChannel.applyDiff(qc, {
      queryKey: key,
      operations: [{ type: "remove", rows: [{ id: "a" }, { id: "c" }] }],
      source: "tab-x",
      timestamp: Date.now()
    });

    const data = qc.getQueryData<Record<string, unknown>[]>(key);
    expect(data).toEqual([{ id: "b", v: 2 }]);
  });

  it("echo prevention — own diffs are not delivered to own callbacks", () => {
    const chan = new RealtimeDiffChannel("tab-a");
    const received: CacheDiff[] = [];
    chan.onDiff((d) => received.push(d));

    chan.broadcastDiff(makeDiff("tab-a"));

    expect(received).toHaveLength(0);

    chan.close();
  });

  it("missing cache tolerance — upsert on empty cache sets initial data", () => {
    const qc = new QueryClient();
    const key = ["empty"];

    RealtimeDiffChannel.applyDiff(qc, {
      queryKey: key,
      operations: [{ type: "upsert", rows: [{ id: 1, name: "first" }] }],
      source: "tab-x",
      timestamp: Date.now()
    });

    const data = qc.getQueryData<Record<string, unknown>[]>(key);
    expect(data).toEqual([{ id: 1, name: "first" }]);
  });

  it("compound diff — single diff with both upsert and remove", () => {
    const qc = new QueryClient();
    const key = ["compound"];
    qc.setQueryData(key, [
      { id: 1, v: "a" },
      { id: 2, v: "b" },
      { id: 3, v: "c" }
    ]);

    RealtimeDiffChannel.applyDiff(qc, {
      queryKey: key,
      operations: [
        // First remove id 2
        { type: "remove", rows: [{ id: 2 }] },
        // Then upsert id 4
        { type: "upsert", rows: [{ id: 4, v: "d" }] }
      ],
      source: "tab-x",
      timestamp: Date.now()
    });

    const data = qc.getQueryData<Record<string, unknown>[]>(key);
    expect(data).toEqual([
      { id: 1, v: "a" },
      { id: 3, v: "c" },
      { id: 4, v: "d" }
    ]);
  });

  it("rapid sequential diffs — multiple diffs all arrive", () => {
    const chanA = new RealtimeDiffChannel("tab-a");
    const chanB = new RealtimeDiffChannel("tab-b");
    const received: CacheDiff[] = [];
    chanB.onDiff((d) => received.push(d));

    for (let i = 0; i < 5; i++) {
      chanA.broadcastDiff(
        makeDiff("tab-a", {
          operations: [{ type: "upsert", rows: [{ id: i, seq: i }] }],
          timestamp: Date.now() + i
        })
      );
    }

    expect(received).toHaveLength(5);
    expect(received.map((d) => d.operations[0].rows[0].seq)).toEqual([0, 1, 2, 3, 4]);

    chanA.close();
    chanB.close();
  });

  it("unsubscribe — callback no longer fires after unsubscribing", () => {
    const chanA = new RealtimeDiffChannel("tab-a");
    const chanB = new RealtimeDiffChannel("tab-b");
    const received: CacheDiff[] = [];
    const unsub = chanB.onDiff((d) => received.push(d));

    chanA.broadcastDiff(makeDiff("tab-a"));
    expect(received).toHaveLength(1);

    unsub();
    chanA.broadcastDiff(makeDiff("tab-a"));
    // Should still be 1 — callback was removed
    expect(received).toHaveLength(1);

    chanA.close();
    chanB.close();
  });
});
