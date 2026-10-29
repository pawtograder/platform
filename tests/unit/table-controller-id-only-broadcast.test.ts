/**
 * @jest-environment node
 *
 * (node, not the jsdom default: the controller drives real fetches through supabase-js, and the
 * fetch stub has to return a `Response`, which jsdom does not provide.)
 *
 * Privacy-aware broadcasts send only `{ id }` as `data`: private help_requests reach the class
 * students channel that way (20251001193829_fix-office-hours-queue-realtime.sql). TableController
 * used to treat any `data` as a full row, so the realtime filter (`class_id`) failed on the
 * missing column and the student's own private request was removed from their list on every
 * update. Escalation depends on that update arriving: it is how the student learns staff resolved
 * the ticket and sees "Did your problem get fixed?". An ID-only payload must refetch the row.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import TableController, { type BroadcastMessage } from "@/lib/TableController";
import type { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import type { ConnectionStatus } from "@/lib/PawtograderRealTimeController";
import type { Database } from "@/utils/supabase/SupabaseTypes";

const CLASS_ID = 7;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json" }
  });
}

function makeController() {
  let handler: ((message: BroadcastMessage) => void) | undefined;
  const realtime = {
    isClosed: false,
    subscribeToTable(_table: string, cb: (message: BroadcastMessage) => void) {
      handler = cb;
      return () => {};
    },
    subscribeToStatus() {
      return () => {};
    },
    getConnectionStatus(): ConnectionStatus {
      return { overall: "connected", channels: [], lastUpdate: new Date() };
    }
  };

  const rowBefore = { id: 1, class_id: CLASS_ID, status: "in_progress", check_in_expires_at: null };
  const rowAfter = { ...rowBefore, status: "resolved", check_in_expires_at: "2026-10-29T18:10:00Z" };
  let fetches = 0;
  const fetchStub = jest.fn(async () => jsonResponse([fetches++ === 0 ? rowBefore : rowAfter]));

  const client = createClient<Database>("http://localhost:54321", "test-anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchStub as unknown as typeof fetch }
  }) as SupabaseClient<Database>;

  const controller = new TableController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: client.from("help_requests").select("*").eq("class_id", CLASS_ID) as any,
    client,
    table: "help_requests",
    classRealTimeController: realtime as unknown as ClassRealTimeController,
    realtimeFilter: { class_id: CLASS_ID },
    debounceInterval: 1
  });

  return { controller, send: (m: BroadcastMessage) => handler!(m), fetchStub };
}

async function settle(controller: { rows: unknown[] }, predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return controller.rows;
}

describe("TableController with an ID-only broadcast payload", () => {
  it("refetches the row instead of dropping it on the realtime filter", async () => {
    const { controller, send, fetchStub } = makeController();
    await controller.readyPromise;
    expect(controller.rows).toHaveLength(1);

    send({
      type: "table_change",
      operation: "UPDATE",
      table: "help_requests",
      row_id: 1,
      data: { id: 1 },
      timestamp: new Date().toISOString()
    } as unknown as BroadcastMessage);

    const rows = (await settle(controller, () => fetchStub.mock.calls.length > 1)) as {
      status: string;
      check_in_expires_at: string | null;
    }[];
    await settle(controller, () => (controller.rows[0] as { status: string } | undefined)?.status === "resolved");

    expect(fetchStub.mock.calls.length).toBeGreaterThan(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "resolved", check_in_expires_at: "2026-10-29T18:10:00Z" });

    controller.close();
  });
});
