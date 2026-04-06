/**
 * Smoke test to verify that all Phase 0 test infrastructure files
 * compile and export correctly under Jest + jsdom.
 */

import { MockBroadcastChannel, resetAllChannels, setupMockBroadcastChannel } from "../mocks/MockBroadcastChannel";
import { MockClassRealTimeController } from "../mocks/MockClassRealTimeController";
import { MockSupabaseClient, createMockSupabaseClient } from "../mocks/MockSupabaseClient";
import { createTestQueryClient } from "../helpers/createTestQueryClient";

afterEach(() => {
  resetAllChannels();
});

describe("MockBroadcastChannel", () => {
  it("delivers messages to peers but not to self", () => {
    const a = new MockBroadcastChannel("test");
    const b = new MockBroadcastChannel("test");

    const received: unknown[] = [];
    a.onmessage = (e) => received.push(e.data);
    b.onmessage = (e) => received.push(e.data);

    a.postMessage("hello");
    // Only b should receive it
    expect(received).toEqual(["hello"]);
  });

  it("close() removes the instance from the registry", () => {
    const a = new MockBroadcastChannel("ch");
    const b = new MockBroadcastChannel("ch");

    const received: unknown[] = [];
    b.onmessage = (e) => received.push(e.data);

    b.close();
    a.postMessage("after-close");
    expect(received).toEqual([]);
  });

  it("setupMockBroadcastChannel assigns to globalThis", () => {
    setupMockBroadcastChannel();
    expect((globalThis as Record<string, unknown>).BroadcastChannel).toBe(MockBroadcastChannel);
  });
});

describe("MockClassRealTimeController", () => {
  it("captures subscriptions and fires simulateBroadcast", () => {
    const ctrl = new MockClassRealTimeController();
    const messages: unknown[] = [];

    const unsub = ctrl.subscribeToTable("assignments", (msg) => messages.push(msg));

    expect(ctrl.getActiveSubscriptions()).toContain("assignments");
    expect(ctrl.getSubscriberCount("assignments")).toBe(1);

    ctrl.simulateBroadcast("assignments", {
      type: "table_change",
      operation: "INSERT",
      table: "assignments",
      row_id: 42
    } as any);
    expect(messages).toHaveLength(1);

    unsub();
    expect(ctrl.getSubscriberCount("assignments")).toBe(0);
  });

  it("getConnectionStatus returns connected", () => {
    const ctrl = new MockClassRealTimeController();
    const status = ctrl.getConnectionStatus();
    expect(status.overall).toBe("connected");
  });
});

describe("MockSupabaseClient", () => {
  it("filters canned data with eq and in", async () => {
    const data = new Map([
      [
        "users",
        [
          { id: 1, name: "Alice", role: "student" },
          { id: 2, name: "Bob", role: "instructor" },
          { id: 3, name: "Carol", role: "student" }
        ]
      ]
    ]);
    const client = createMockSupabaseClient(data);

    const { data: students } = await client.from("users").select("*").eq("role", "student");
    expect(students).toHaveLength(2);

    const { data: subset } = await client.from("users").select("*").in("id", [1, 3]);
    expect(subset).toHaveLength(2);
    expect(subset!.map((r) => r.name)).toEqual(["Alice", "Carol"]);
  });

  it("returns empty array for unknown tables", async () => {
    const client = new MockSupabaseClient(new Map());
    const { data } = await client.from("nonexistent").select("*");
    expect(data).toEqual([]);
  });
});

describe("createTestQueryClient", () => {
  it("creates a QueryClient with retry disabled", () => {
    const qc = createTestQueryClient();
    const defaults = qc.getDefaultOptions();
    expect(defaults.queries?.retry).toBe(false);
    expect(defaults.mutations?.retry).toBe(false);
  });
});
