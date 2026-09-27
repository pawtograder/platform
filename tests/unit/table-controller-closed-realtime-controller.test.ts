/**
 * @jest-environment node
 *
 * (node, not the jsdom default: this test drives a real initial fetch through supabase-js, and
 * the fetch stub has to return a `Response`, which jsdom does not provide.)
 *
 * Regression test for the "Cannot subscribe to channels after they have been closed"
 * production error (unhandled rejection, reported from onunhandledrejection).
 *
 * Root cause: TableController's ready promise awaits the initial fetch and then subscribes to
 * the class realtime controller, guarding only on its OWN `_closed` flag. A navigation during
 * that fetch closes the ClassRealTimeController — which is what the reported breadcrumbs show
 * (channel `teardown` / `status: CLOSED` right after a route change) — while this TableController
 * is still open, so the subscribe call threw out of the promise executor with nobody to catch it.
 *
 * The fix also checks the controller's `isClosed`: a closed controller has torn down its channels
 * and cannot be revived, so there is nothing to subscribe to. The fetched rows stay in place and
 * the ready promise resolves normally.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import TableController from "@/lib/TableController";
import type { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import type { ConnectionStatus } from "@/lib/PawtograderRealTimeController";
import type { Database } from "@/utils/supabase/SupabaseTypes";

const CLOSED_ERROR = "Cannot subscribe to channels after they have been closed";

/**
 * Stands in for ClassRealTimeController: throws from its subscribe methods once closed, exactly
 * as the real one does.
 */
function makeFakeRealTimeController() {
  const fake = {
    closed: false,
    subscribeToTableCalls: 0,
    get isClosed() {
      return fake.closed;
    },
    subscribeToTable() {
      if (fake.closed) throw new Error(CLOSED_ERROR);
      fake.subscribeToTableCalls++;
      return () => {};
    },
    subscribeToTableForSubmission() {
      if (fake.closed) throw new Error(CLOSED_ERROR);
      fake.subscribeToTableCalls++;
      return () => {};
    },
    subscribeToStatus() {
      return () => {};
    },
    getConnectionStatus(): ConnectionStatus {
      return { overall: "connected", channels: [], lastUpdate: new Date() };
    }
  };
  return fake;
}

/**
 * @param closeDuringFetch when true, the controller is closed while the initial fetch is in
 * flight — the navigation-mid-fetch race from production.
 */
function makeController(closeDuringFetch: boolean) {
  const realtime = makeFakeRealTimeController();

  const fetchStub = jest.fn(async () => {
    if (closeDuringFetch) {
      realtime.closed = true;
    }
    return new Response("[]", {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json" }
    });
  });

  const client = createClient<Database>("http://localhost:54321", "test-anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchStub as unknown as typeof fetch }
  }) as SupabaseClient<Database>;

  const controller = new TableController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: client.from("profiles").select("*").eq("class_id", 1) as any,
    client,
    table: "profiles",
    classRealTimeController: realtime as unknown as ClassRealTimeController,
    loadEntireTable: true
  });

  return { controller, realtime };
}

describe("TableController with a class realtime controller closed mid-fetch", () => {
  it("resolves ready instead of rejecting, and skips the subscription", async () => {
    const { controller, realtime } = makeController(true);

    await expect(controller.readyPromise).resolves.toBeUndefined();
    expect(realtime.isClosed).toBe(true);
    expect(realtime.subscribeToTableCalls).toBe(0);

    controller.close();
  });

  it("still subscribes when the controller stays open", async () => {
    const { controller, realtime } = makeController(false);

    await expect(controller.readyPromise).resolves.toBeUndefined();
    expect(realtime.subscribeToTableCalls).toBe(1);

    controller.close();
  });
});
