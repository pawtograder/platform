/**
 * Realtime ingest (package 2): RealtimeChannelManager's broadcast routing hands full-row
 * broadcasts to the taint ingest while it runs, and ID-only broadcasts add nothing (the
 * controller's refetch comes back through the fetch hook).
 */
import { RealtimeChannelManager } from "@/lib/RealtimeChannelManager";
import { bugReportIngest } from "@/lib/bugReport/ingestGate";
import { startIngest } from "@/lib/bugReport/ingest";
import { getTaintSet } from "@/lib/bugReport/taint";

type Routable = {
  _channels: Map<string, { subscriptions: { callback: (m: unknown) => void }[] }>;
  _routeMessage(topic: string, message: unknown): void;
};

function manager(): Routable {
  const m = RealtimeChannelManager.getInstance() as unknown as Routable;
  m._channels.set("class:1:staff", { subscriptions: [{ callback: () => {} }] });
  return m;
}

afterEach(() => getTaintSet().clear());

describe("realtime ingest", () => {
  it("does nothing without a running ingest", () => {
    expect(bugReportIngest.sink).toBeNull();
    manager()._routeMessage("class:1:staff", {
      type: "table_change",
      table: "profiles",
      data: { id: "p", name: "Broadcast Zorvik" }
    });
    expect(getTaintSet().size).toBe(0);
  });

  it("classifies a full-row broadcast (D4 shape)", async () => {
    const ingest = startIngest({ getSessionUser: async () => null });
    try {
      const received: unknown[] = [];
      const m = manager();
      m._channels.get("class:1:staff")!.subscriptions.push({ callback: (msg) => received.push(msg) });
      m._routeMessage("class:1:staff", {
        type: "table_change",
        operation: "INSERT",
        table: "help_requests",
        row_id: 5,
        data: { id: 5, request: "My zorvik loop never ends", class_id: 1 },
        class_id: 1,
        timestamp: "2026-09-29T00:00:00Z"
      });
      expect(received).toHaveLength(1);
      expect(getTaintSet().has("My zorvik loop never ends")).toBe(true);
      expect(ingest.stats().broadcasts).toBe(1);
    } finally {
      ingest.stop();
    }
  });

  it("adds nothing for an ID-only broadcast (D5 shape)", () => {
    const ingest = startIngest({ getSessionUser: async () => null });
    try {
      manager()._routeMessage("class:1:staff", {
        type: "table_change",
        operation: "UPDATE",
        table: "gradebook_column_students",
        row_id: 9,
        class_id: 1,
        timestamp: "2026-09-29T00:00:00Z"
      });
      expect(getTaintSet().size).toBe(0);
      expect(ingest.stats().broadcasts).toBe(0);
    } finally {
      ingest.stop();
    }
  });

  it("classifies postgres_changes rows through the sink", () => {
    const ingest = startIngest({ getSessionUser: async () => null });
    try {
      bugReportIngest.sink?.rows("help_requests", { id: 1, request: "Video zorvik request", is_video_live: false });
      expect(getTaintSet().has("Video zorvik request")).toBe(true);
    } finally {
      ingest.stop();
    }
  });
});
