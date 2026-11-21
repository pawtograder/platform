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
 * the ticket and sees "Did your problem get fixed?". An ID-only payload must refetch the row, and
 * a row the refetch no longer returns (made private, so invisible under RLS) must be evicted.
 *
 * Every online student receives those ID-only updates, for every private ticket in the class
 * (#1310). A row the client doesn't hold is fetched only when `shouldRefetchUncachedIdOnly` says
 * so, otherwise each private-ticket edit costs one GET per online student that returns nothing.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import TableController, { type BroadcastMessage } from "@/lib/TableController";
import type { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import type { ConnectionStatus } from "@/lib/PawtograderRealTimeController";
import type { Database } from "@/utils/supabase/SupabaseTypes";

const CLASS_ID = 7;
const ROW = { id: 1, class_id: CLASS_ID, status: "in_progress", check_in_expires_at: null };

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" }
  });
}

/** `refetch` decides what the second and later fetches (the ID-only refetch) return. */
function makeController(refetch: () => Response, shouldRefetchUncachedIdOnly?: (id: number) => boolean) {
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

  let fetches = 0;
  const fetchStub = jest.fn(async () => (fetches++ === 0 ? respond(200, [ROW]) : refetch()));

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
    debounceInterval: 1,
    shouldRefetchUncachedIdOnly
  });

  const sendIdOnlyUpdate = (id = 1) =>
    handler!({
      type: "table_change",
      operation: "UPDATE",
      table: "help_requests",
      row_id: id,
      data: { id },
      timestamp: new Date().toISOString()
    } as unknown as BroadcastMessage);

  return { controller, sendIdOnlyUpdate, fetchStub };
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("TableController with an ID-only broadcast payload", () => {
  it("refetches the row instead of dropping it on the realtime filter", async () => {
    const updated = { ...ROW, status: "resolved", check_in_expires_at: "2026-10-29T18:10:00Z" };
    const { controller, sendIdOnlyUpdate } = makeController(() => respond(200, [updated]));
    await controller.readyPromise;

    sendIdOnlyUpdate();
    await waitFor(() => (controller.rows[0] as { status?: string } | undefined)?.status === "resolved");

    expect(controller.rows).toHaveLength(1);
    expect(controller.rows[0]).toMatchObject({ status: "resolved", check_in_expires_at: "2026-10-29T18:10:00Z" });
    controller.close();
  });

  it("evicts a row the refetch no longer returns (now invisible under RLS)", async () => {
    const { controller, sendIdOnlyUpdate } = makeController(() => respond(200, []));
    await controller.readyPromise;
    expect(controller.rows).toHaveLength(1);

    sendIdOnlyUpdate();
    await waitFor(() => controller.rows.length === 0);

    expect(controller.rows).toHaveLength(0);
    controller.close();
  });

  it("keeps the row when the refetch fails", async () => {
    const { controller, sendIdOnlyUpdate, fetchStub } = makeController(() =>
      respond(500, { message: "boom", code: "XX000" })
    );
    await controller.readyPromise;

    sendIdOnlyUpdate();
    await waitFor(() => fetchStub.mock.calls.length > 1);
    await new Promise((r) => setTimeout(r, 50));

    expect(controller.rows).toHaveLength(1);
    controller.close();
  });

  it("doesn't fetch an uncached row the check turns down", async () => {
    const shouldRefetch = jest.fn(() => false);
    const { controller, sendIdOnlyUpdate, fetchStub } = makeController(() => respond(200, []), shouldRefetch);
    await controller.readyPromise;
    expect(fetchStub).toHaveBeenCalledTimes(1);

    sendIdOnlyUpdate(2);
    // The check and the fetch it would allow happen in the same synchronous pass of the update
    // batch, so once the check has run, a fetch would already have been made.
    await waitFor(() => shouldRefetch.mock.calls.length > 0);

    expect(shouldRefetch).toHaveBeenCalledWith(2);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(controller.rows).toHaveLength(1);
    controller.close();
  });

  it("fetches and adds an uncached row the check allows", async () => {
    const added = { id: 2, class_id: CLASS_ID, status: "open", check_in_expires_at: null };
    const { controller, sendIdOnlyUpdate } = makeController(
      () => respond(200, [added]),
      (id) => id === 2
    );
    await controller.readyPromise;

    sendIdOnlyUpdate(2);
    await waitFor(() => controller.rows.length === 2);

    expect(controller.rows.map((r) => (r as { id: number }).id).sort()).toEqual([1, 2]);
    controller.close();
  });

  it("still refetches a cached row when the check would turn it down", async () => {
    const updated = { ...ROW, status: "resolved" };
    const { controller, sendIdOnlyUpdate } = makeController(
      () => respond(200, [updated]),
      () => false
    );
    await controller.readyPromise;

    sendIdOnlyUpdate(1);
    await waitFor(() => (controller.rows[0] as { status?: string } | undefined)?.status === "resolved");

    expect(controller.rows[0]).toMatchObject({ status: "resolved" });
    controller.close();
  });
});
