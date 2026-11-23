/**
 * Realtime routing contract for broadcast_help_queue_data_change()
 * (supabase/migrations/20261119200000_restore_class_scoped_help_queue_broadcast.sql).
 *
 * 20250929004834 rewrote this trigger function and silently changed which topics it sends to.
 * Queue edits stopped reaching help_queues:<class_id>, the topic OfficeHoursRealTimeController
 * listens on (issue #1082), and private help requests started going to help_queue:<id>, which any
 * class member may join. Neither showed up as an error. This spec subscribes real clients to the
 * topics and pins the routing:
 *   - a queue edit reaches a staff member listening on help_queues:<class_id>;
 *   - a public help request reaches a student on help_queue:<id> and help_queues:<class_id>, and
 *     a private one reaches help_queues:<class_id>:staff but never those two student topics;
 *   - a student cannot join help_queues:<class_id>:staff at all.
 *
 * safe_broadcast() sends nothing to a topic without a live lease in
 * realtime_channel_subscriptions, so every listener here registers one, the same way
 * RealtimeChannelManager does.
 *
 * Lives at tests/e2e/ root, NOT in a subdirectory, so playwright.config.ts's testIgnore does not
 * skip it.
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "../global-setup";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  insertHelpRequest,
  insertOfficeHoursQueue,
  supabase,
  type TestingUser
} from "./TestingUtils";

type QueueChangePayload = { type: string; table: string; row_id: number; operation: string };

type Listener = {
  messages: QueueChangePayload[];
  channel: RealtimeChannel;
};

/** Join a private broadcast topic and hold a lease on it so safe_broadcast() delivers to it. */
async function listen(client: SupabaseClient<Database>, topic: string): Promise<Listener> {
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error(`listen(${topic}): client has no session`);
  await client.realtime.setAuth(data.session.access_token);

  const messages: QueueChangePayload[] = [];
  const channel = client.channel(topic, { config: { private: true } });
  channel.on("broadcast", { event: "broadcast" }, (message) => {
    messages.push(message.payload as QueueChangePayload);
  });
  await new Promise<void>((resolve, reject) => {
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") resolve();
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        reject(new Error(`listen(${topic}): ${status}${err ? ` ${err.message}` : ""}`));
      }
    });
  });

  const { error } = await client.rpc("register_realtime_subscription", {
    p_channel: topic,
    p_client_id: randomUUID()
  });
  if (error) throw new Error(`listen(${topic}): lease registration failed: ${error.message}`);
  return { messages, channel };
}

function received(listener: Listener, table: string, rowId: number) {
  return listener.messages.filter((m) => m.type === "queue_change" && m.table === table && m.row_id === rowId);
}

test.describe("help queue realtime routing contract", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  let classId: number;
  let queueId: number;
  let privateRequestId: number;
  let publicRequestId: number;
  let grader: TestingUser;
  let student: TestingUser;
  let graderClient: SupabaseClient<Database>;
  let studentClient: SupabaseClient<Database>;
  const listeners: Listener[] = [];

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Help Queue RT Contract ${suffix}` });
    classId = course.id;
    [grader, student] = await createUsersInClass([
      {
        name: `E2E HQ Contract Grader ${suffix}`,
        email: `e2e-hq-contract-grader-${suffix}@pawtograder.net`,
        role: "grader",
        class_id: classId,
        useMagicLink: true
      },
      {
        name: `E2E HQ Contract Student ${suffix}`,
        email: `e2e-hq-contract-student-${suffix}@pawtograder.net`,
        role: "student",
        class_id: classId,
        useMagicLink: true
      }
    ]);
    queueId = (await insertOfficeHoursQueue({ class_id: classId, name: `HQ Contract Queue ${suffix}` })).id;

    const request = await insertHelpRequest({
      class_id: classId,
      help_queue_id: queueId,
      student_profile_id: student.private_profile_id,
      request: `Private request ${suffix}`
    });
    privateRequestId = request.id;
    const { error } = await supabase.from("help_requests").update({ is_private: true }).eq("id", privateRequestId);
    if (error) throw new Error(`make request private failed: ${error.message}`);

    publicRequestId = (
      await insertHelpRequest({
        class_id: classId,
        help_queue_id: queueId,
        student_profile_id: student.private_profile_id,
        request: `Public request ${suffix}`
      })
    ).id;

    graderClient = await createAuthenticatedClient(grader);
    studentClient = await createAuthenticatedClient(student);
  });

  test.afterAll(async () => {
    for (const listener of listeners) {
      await listener.channel.unsubscribe();
    }
  });

  test("a queue edit reaches staff on help_queues:<class_id>", async () => {
    const staffOnClassTopic = await listen(graderClient, `help_queues:${classId}`);
    listeners.push(staffOnClassTopic);

    // Re-apply the edit until it lands, so a broadcast sent while the join is still settling
    // retries instead of flaking. With the routing regressed, no edit ever arrives.
    let attempt = 0;
    await expect(async () => {
      attempt += 1;
      const { error } = await supabase
        .from("help_queues")
        .update({ name: `HQ Contract Queue renamed ${attempt}` })
        .eq("id", queueId);
      expect(error).toBeNull();
      await expect
        .poll(() => received(staffOnClassTopic, "help_queues", queueId).length, { timeout: 5_000 })
        .toBeGreaterThan(0);
    }).toPass({ timeout: 45_000 });
  });

  test("a public help request reaches students, a private one reaches staff only", async () => {
    const staffChannel = await listen(graderClient, `help_queues:${classId}:staff`);
    const studentOnQueueTopic = await listen(studentClient, `help_queue:${queueId}`);
    const studentOnClassTopic = await listen(studentClient, `help_queues:${classId}`);
    listeners.push(staffChannel, studentOnQueueTopic, studentOnClassTopic);

    // Two positive controls make the students' silence about the private request meaningful:
    // the public request reaching both student topics proves those subscriptions deliver, and
    // the private request reaching staff proves its trigger fired.
    await expect(async () => {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("help_requests")
        .update({ updated_at: now })
        .in("id", [publicRequestId, privateRequestId]);
      expect(error).toBeNull();
      await expect
        .poll(
          () =>
            Math.min(
              received(studentOnQueueTopic, "help_requests", publicRequestId).length,
              received(studentOnClassTopic, "help_requests", publicRequestId).length,
              received(staffChannel, "help_requests", privateRequestId).length
            ),
          { timeout: 5_000 }
        )
        .toBeGreaterThan(0);
    }).toPass({ timeout: 45_000 });

    // Give any misrouted copy time to arrive before asserting that none did.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(received(studentOnQueueTopic, "help_requests", privateRequestId)).toHaveLength(0);
    expect(received(studentOnClassTopic, "help_requests", privateRequestId)).toHaveLength(0);
  });

  test("a student cannot join help_queues:<class_id>:staff", async () => {
    await expect(listen(studentClient, `help_queues:${classId}:staff`)).rejects.toThrow(/CHANNEL_ERROR|TIMED_OUT/);
  });
});
