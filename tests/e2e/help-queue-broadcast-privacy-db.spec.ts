import { expect, test } from "@playwright/test";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertOfficeHoursQueue,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

/**
 * The queue-channel broadcast from 20261119140000_help_queue_broadcast_privacy.sql.
 *
 * Every subscriber of a queue's channel receives its requests, including students who are not on
 * them. A private request must therefore carry only its id and let the subscriber refetch the row
 * under RLS. A public request still carries the full row, which is what the queue list renders.
 *
 * The subscriber here is a second student who is on no request in the queue, which is the case
 * that leaked before.
 */
test.describe("help queue broadcast privacy", () => {
  test.describe.configure({ timeout: 120_000 });

  let classId: number;
  let queueId: number;
  let author: TestingUser;
  let watcher: SupabaseClient<Database>;
  const received: { table?: string; operation?: string; row_id?: number; data?: Record<string, unknown> }[] = [];

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Queue Broadcast Privacy ${suffix}` });
    classId = course.id;
    author = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Queue Privacy Author ${suffix}`,
      email: `e2e-queue-privacy-author-${suffix}@pawtograder.net`
    });
    const bystander = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Queue Privacy Bystander ${suffix}`,
      email: `e2e-queue-privacy-bystander-${suffix}@pawtograder.net`
    });
    queueId = (await insertOfficeHoursQueue({ class_id: classId, name: `Privacy queue ${suffix}` })).id;

    const topic = `help_queue:${queueId}`;
    watcher = await createAuthenticatedClient(bystander);
    // safe_broadcast only sends to a channel with a live lease, as the app's RealtimeChannelManager registers.
    const { error: leaseError } = await watcher.rpc("register_realtime_subscription", {
      p_channel: topic,
      p_client_id: crypto.randomUUID()
    });
    expect(leaseError).toBeNull();
    // The test client doesn't persist its session, so hand the realtime socket the token itself.
    const { data: session } = await watcher.auth.getSession();
    await watcher.realtime.setAuth(session.session!.access_token);
    const channel = watcher.channel(topic, { config: { private: true } });
    channel.on("broadcast", { event: "broadcast" }, ({ payload }) => received.push(payload));
    await new Promise<void>((resolve, reject) =>
      channel.subscribe((status, err) => {
        if (status === "SUBSCRIBED") resolve();
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(err ?? new Error(status));
      })
    );
  });

  test.afterAll(async () => {
    await watcher?.removeAllChannels();
  });

  /** Waits for the queue broadcast of one operation on this request, and returns its `data`. */
  async function broadcastFor(requestId: number, operation: "INSERT" | "UPDATE"): Promise<Record<string, unknown>> {
    const matches = () =>
      received.filter((p) => p.table === "help_requests" && p.row_id === requestId && p.operation === operation);
    // 30s, not 15s: the channel is already SUBSCRIBED by the time a test runs, but on a database
    // that has just been reset the first INSERT -> trigger -> broadcast round trip has to wait for
    // PostgREST's schema cache to warm, which took over 15s locally and timed out this first test
    // while the two after it passed in milliseconds. e2e-local also runs against a fresh reset.
    await expect.poll(() => matches().length > 0, { timeout: 30_000 }).toBe(true);
    const payload = matches().pop();
    if (!payload?.data) {
      throw new Error(`${operation} broadcast for help request ${requestId} carried no data`);
    }
    return payload.data;
  }

  /** A help request created straight through the table, so `is_private` is set on the INSERT itself. */
  async function insertRequest(isPrivate: boolean): Promise<number> {
    const { data, error } = await supabase
      .from("help_requests")
      .insert({
        class_id: classId,
        help_queue: queueId,
        request: isPrivate ? "Private request, id only" : "Public request, full payload",
        status: "open",
        created_by: author.private_profile_id,
        is_private: isPrivate,
        location_type: "remote"
      })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`Failed to create help request: ${error?.message ?? "no row"}`);
    }
    return data.id;
  }

  test("a public request is broadcast with its full row", async () => {
    const id = await insertRequest(false);

    const data = await broadcastFor(id, "INSERT");
    expect(data.id).toBe(id);
    expect(data).toHaveProperty("status");
    expect(data).toHaveProperty("help_queue");
  });

  test("a private request is broadcast with only its id", async () => {
    const id = await insertRequest(true);

    const data = await broadcastFor(id, "INSERT");
    expect(Object.keys(data)).toEqual(["id"]);
    expect(data.id).toBe(id);
  });

  test("a public request that is made private is redacted from the next broadcast on", async () => {
    const id = await insertRequest(false);
    await broadcastFor(id, "INSERT");

    const { error } = await supabase.from("help_requests").update({ is_private: true }).eq("id", id);
    if (error) {
      throw new Error(`Failed to make help request ${id} private: ${error.message}`);
    }

    const data = await broadcastFor(id, "UPDATE");
    expect(Object.keys(data)).toEqual(["id"]);
    expect(data.id).toBe(id);
  });
});
