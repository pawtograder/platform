/** @jest-environment node */
import { createClient } from "@supabase/supabase-js";
import TableController from "@/lib/TableController";
import type { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import type { BroadcastMessage, ClassRealTimeController } from "@/lib/ClassRealTimeController";

jest.mock("@/lib/bugReport/ingestGate", () => ({
  bugReportIngest: {},
  registerRowSource: jest.fn(),
  unregisterRowSource: jest.fn()
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }));

test("natural keys page all rows, distinguish capabilities on one role, and apply row broadcasts", async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => ({ role_id: 7, capability: `cap_${index}` }));
  const requests: URL[] = [];
  let fail = false;
  const onError = jest.fn();
  const client = createClient<Database>("http://localhost:54321", "test", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input) => {
        if (fail) return new Response(JSON.stringify({ message: "Unavailable" }), { status: 503 });
        const url = new URL(String(input));
        requests.push(url);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? rows.length);
        const capability = url.searchParams.get("capability")?.replace(/^eq\./, "");
        const matching = capability ? rows.filter((row) => row.capability === capability) : rows;
        return new Response(JSON.stringify(matching.slice(offset, offset + limit)), { status: 200 });
      }
    }
  });
  let receive!: (message: BroadcastMessage) => void;
  const realtime = {
    isClosed: false,
    subscribeToTable: (_table: string, callback: typeof receive) => {
      receive = callback;
      return () => {};
    },
    subscribeToStatus: () => () => {},
    getConnectionStatus: () => ({ channels: [] })
  } as unknown as ClassRealTimeController;
  const controller = new TableController({
    client,
    onError,
    table: "role_capabilities",
    keyColumns: ["role_id", "capability"],
    query: client.from("role_capabilities").select("*"),
    classRealTimeController: realtime,
    debounceInterval: 1,
    debounceJitter: 0
  });
  try {
    await controller.readyPromise;
    expect(controller.rowCount).toBe(1001);
    expect(requests).toHaveLength(2);
    expect(requests[0].searchParams.get("order")).toBe("role_id.asc,capability.asc");
    const changed = new Promise<void>((resolve) => {
      controller.list((data) => {
        if (data.length === 1000) resolve();
      });
    });
    receive({
      type: "staff_data_change",
      table: "role_capabilities",
      class_id: 1,
      operation: "DELETE",
      row_id: 7,
      data: rows[0],
      timestamp: new Date().toISOString()
    });
    await changed;
    expect(controller.rows.some((row) => row.capability === "cap_0")).toBe(false);
    expect(controller.rows.some((row) => row.capability === "cap_1")).toBe(true);
    const inserted = new Promise<void>((resolve) => {
      controller.list((data) => {
        if (data.some((row) => row.capability === "new_cap")) resolve();
      });
    });
    receive({
      type: "staff_data_change",
      table: "role_capabilities",
      class_id: 1,
      operation: "INSERT",
      row_id: 7,
      data: { role_id: 7, capability: "new_cap" },
      timestamp: new Date().toISOString()
    });
    await inserted;
    expect(controller.rowCount).toBe(1001);
    expect(requests).toHaveLength(2);
    const row = await controller._fetchRow(JSON.stringify([7, "cap_1"]));
    expect(row?.capability).toBe("cap_1");
    expect(requests[2].searchParams.get("role_id")).toBe("eq.7");
    expect(requests[2].searchParams.has("id")).toBe(false);
    fail = true;
    await expect(controller.refetchAll({ force: true })).rejects.toMatchObject({ message: "Unavailable" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(controller.rowCount).toBe(1001);
  } finally {
    controller.close();
  }
});
