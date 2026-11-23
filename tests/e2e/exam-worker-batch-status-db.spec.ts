/**
 * #1158: exam_worker_set_batch_status changes a batch's status only while the calling worker still
 * holds its queue message, and only from the states the caller allows, in one transaction
 * (20261122130000_pgmq_public_set_vt_if_claimed.sql).
 *
 * A worker whose lease lapsed keeps running. If it checked its claim and then wrote in a separate
 * step, another reader could claim the message in between. These tests drive both interleavings
 * over two real connections: the write holding the message while a reader tries to claim it, and a
 * reader claiming it while the write waits. Claims go through pgmq.read itself, filtered to this
 * test's message with pgmq.read's `conditional` argument, so no other message is touched.
 *
 * Needs the disposable-database variables courseGeminiKeyDb.ts checks (CI's e2e-local sets them).
 */
import { expect, test } from "@playwright/test";
import { randomUUID } from "crypto";
import type { Client } from "pg";
import { addDays } from "date-fns";
import { backendPid, beginAsUser, privilegedClient, waitUntilBlocked } from "./courseGeminiKeyDb";
import { runExamWorker } from "./examScanFixture";
import { createAuthenticatedClient, createClass, createUserInClass, insertAssignment, supabase } from "./TestingUtils";
import {
  ackArgs,
  giveUpArgs,
  linkArgs,
  requeueArgs,
  suggestionArgs
} from "../../supabase/functions/_shared/examWorkerFence";
import { PAGES_CHANGED_ERROR_FROM } from "../../supabase/functions/exam-async-worker/batchTransitions";

type Claim = { msgId: number; readCt: number; tag: string };

// The `fake` vision provider reads text from the object path, not pixels (see examScanFixture.ts).
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function seedBatch(status: string) {
  const course = await createClass({ name: "Worker batch status" });
  const assignment = await insertAssignment({
    class_id: course.id,
    name: "Batch status exam",
    assignment_type: "exam",
    due_date: addDays(new Date(), 7).toISOString()
  });
  const { data: examId } = await supabase.rpc("exam_create", {
    p_assignment_id: assignment.id,
    p_source_type: "pdf",
    p_num_pages: 1
  });
  const { data: batch, error } = await supabase
    .from("exam_scan_batches")
    .insert({ class_id: course.id, exam_id: examId as number, total_pages: 1, pages_per_exam: 1, status })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { classId: course.id, examId: examId as number, batchId: batch!.id };
}

/**
 * Queue a message for the batch and claim it the way the worker does (pgmq.read), as "our" worker.
 * scanned_submission_id -1: if a running worker ever picked it up, finalize would only fail to find
 * the row, before touching any batch.
 */
async function queueAndClaim(client: Client, classId: number, batchId: number): Promise<Claim> {
  // Sent and claimed in one transaction, so a running worker never sees it unclaimed.
  await client.query("BEGIN");
  const claim = await queueAndClaimInTx(client, classId, batchId);
  await client.query("COMMIT");
  return claim;
}

/** queueAndClaim inside the caller's transaction. */
async function queueAndClaimInTx(client: Client, classId: number, batchId: number): Promise<Claim> {
  const tag = randomUUID();
  queuedTags.add(tag);
  const message = {
    method: "finalize",
    class_id: classId,
    batch_id: batchId,
    args: { scanned_submission_id: -1 },
    test_tag: tag
  };
  const sent = await client.query<{ id: string }>("SELECT pgmq.send('exam_processing', $1::jsonb) AS id", [
    JSON.stringify(message)
  ]);
  const claim = await claimAs(client, tag);
  expect(claim?.msgId).toBe(Number(sent.rows[0].id));
  return claim!;
}

/**
 * Tags of the messages queueAndClaimInTx committed in the current test. They sit in the shared queue,
 * so they are archived after every test, passed or failed: a test that fails between committing a
 * message (or its re-queued replacement, which keeps the tag) and its own cleanup would otherwise
 * leave it for the running worker and the other tests.
 */
const queuedTags = new Set<string>();
test.afterEach(async () => {
  if (queuedTags.size === 0) return;
  const client = await privilegedClient();
  try {
    for (const tag of queuedTags) await cleanupTag(client, tag);
  } finally {
    queuedTags.clear();
    await client.end();
  }
});

/** pgmq.read restricted to this test's message. Returns null when nothing was claimable. */
async function claimAs(client: Client, tag: string): Promise<Claim | null> {
  const { rows } = await client.query<{ msg_id: string; read_ct: number }>(
    "SELECT msg_id, read_ct FROM pgmq.read('exam_processing', 30, 1, $1::jsonb)",
    [JSON.stringify({ test_tag: tag })]
  );
  return rows.length ? { msgId: Number(rows[0].msg_id), readCt: rows[0].read_ct, tag } : null;
}

/** Whether `claim` is still the claim on its message: the check every worker function makes. */
async function holds(client: Client, claim: Pick<Claim, "msgId" | "readCt">): Promise<boolean> {
  const { rows } = await client.query("SELECT 1 FROM pgmq.q_exam_processing WHERE msg_id = $1 AND read_ct = $2", [
    claim.msgId,
    claim.readCt
  ]);
  return rows.length === 1;
}

/** Make the message claimable again, as if our lease had lapsed (committed). */
async function lapse(client: Client, msgId: number) {
  await client.query(
    "UPDATE pgmq.q_exam_processing SET vt = clock_timestamp() - interval '1 second' WHERE msg_id = $1",
    [msgId]
  );
}

async function setStatus(
  client: Client,
  claim: Pick<Claim, "msgId" | "readCt">,
  batchId: number,
  status: string,
  from: string[],
  error: string | null = null
): Promise<string> {
  const { rows } = await client.query<{ outcome: string }>(
    "SELECT public.exam_worker_set_batch_status($1, $2, $3, $4, $5::text[], $6) AS outcome",
    [claim.msgId, claim.readCt, batchId, status, from, error]
  );
  return rows[0].outcome;
}

async function batchRow(batchId: number) {
  const { data, error } = await supabase.from("exam_scan_batches").select("status, error").eq("id", batchId).single();
  expect(error, error?.message).toBeNull();
  return data;
}

async function cleanup(client: Client, msgId: number) {
  await client.query("SELECT pgmq.archive('exam_processing', $1::bigint)", [msgId]);
}

/**
 * A query the test expects to block. If an assertion fails before the test awaits it, cleanup ends
 * its client and the query rejects with nobody listening; that unhandled rejection is reported on
 * top of, or instead of, the real failure. Handling it here as soon as it starts prevents that;
 * awaiting the returned promise, or `expect(...).rejects`, still sees the outcome.
 */
function blockedQuery<T>(query: Promise<T>): Promise<T> {
  query.catch(() => {});
  return query;
}

test.describe("exam_worker_set_batch_status: only the message's current holder moves the batch (#1158)", () => {
  test("the holder's write applies; a stale claim token changes nothing", async () => {
    const { classId, batchId } = await seedBatch("ocr");
    const client = await privilegedClient();
    try {
      const ours = await queueAndClaim(client, classId, batchId);
      expect(
        await setStatus(client, { msgId: ours.msgId, readCt: ours.readCt - 1 }, batchId, "error", ["ocr"], "x")
      ).toBe("not_owner");
      expect(await batchRow(batchId)).toEqual({ status: "ocr", error: null });
      expect(await setStatus(client, ours, batchId, "matching", ["ocr", "matching"])).toBe("applied");
      expect(await batchRow(batchId)).toEqual({ status: "matching", error: null });
      await cleanup(client, ours.msgId);
    } finally {
      await client.end();
    }
  });

  test("an archived message is no one's: its holder's status write changes nothing", async () => {
    // What a worker sees when another reader archived its message under it (an expired holder that
    // finished; see the last describe): every later status write it makes is refused.
    const { classId, batchId } = await seedBatch("finalizing");
    const client = await privilegedClient();
    try {
      const ours = await queueAndClaim(client, classId, batchId);
      await cleanup(client, ours.msgId);
      expect(await setStatus(client, ours, batchId, "completed", ["finalizing"])).toBe("not_owner");
      expect(await batchRow(batchId)).toEqual({ status: "finalizing", error: null });
    } finally {
      await client.end();
    }
  });

  test("the batch must be in an allowed state: a stale error cannot overwrite completed", async () => {
    const { classId, batchId } = await seedBatch("completed");
    const client = await privilegedClient();
    try {
      const ours = await queueAndClaim(client, classId, batchId);
      expect(await setStatus(client, ours, batchId, "error", ["finalizing"], "late failure")).toBe("state_changed");
      expect(await batchRow(batchId)).toEqual({ status: "completed", error: null });
      await cleanup(client, ours.msgId);
    } finally {
      await client.end();
    }
  });

  test("write first: while the write holds the message, a reader cannot claim it", async () => {
    const { classId, batchId } = await seedBatch("finalizing");
    const writer = await privilegedClient();
    const reader = await privilegedClient();
    try {
      const ours = await queueAndClaim(writer, classId, batchId);
      // The reader can only claim a committed, visible message. Between this commit and the write's
      // lock a running worker could take it first (milliseconds; the test would then fail, not pass).
      await lapse(writer, ours.msgId);
      await writer.query("BEGIN");
      expect(await setStatus(writer, ours, batchId, "error", ["finalizing"], "exhausted")).toBe("applied");
      // pgmq.read skips the locked row instead of claiming it under the write.
      expect(await claimAs(reader, ours.tag)).toBeNull();
      // Hide the message again before committing, so nothing else picks it up after the test.
      await writer.query(
        "UPDATE pgmq.q_exam_processing SET vt = clock_timestamp() + interval '1 hour' WHERE msg_id = $1",
        [ours.msgId]
      );
      await writer.query("COMMIT");
      expect(await batchRow(batchId)).toEqual({ status: "error", error: "exhausted" });
      const { rows } = await writer.query<{ read_ct: number }>(
        "SELECT read_ct FROM pgmq.q_exam_processing WHERE msg_id = $1",
        [ours.msgId]
      );
      expect(rows[0].read_ct).toBe(ours.readCt);
      await cleanup(writer, ours.msgId);
    } finally {
      await writer.end();
      await reader.end();
    }
  });

  test("claim first: a write that waits on a new reader's claim then finds it is not the holder", async () => {
    const { classId, batchId } = await seedBatch("finalizing");
    const writer = await privilegedClient();
    const reader = await privilegedClient();
    const monitor = await privilegedClient();
    try {
      const ours = await queueAndClaim(writer, classId, batchId);
      // Our lease lapses and a new reader claims the message, both inside the reader's transaction
      // (so no running worker can take it first). The write below must wait for that transaction.
      await reader.query("BEGIN");
      await lapse(reader, ours.msgId);
      const theirs = await claimAs(reader, ours.tag);
      expect(theirs).toEqual({ msgId: ours.msgId, readCt: ours.readCt + 1, tag: ours.tag });
      const writerPid = await backendPid(writer);
      const readerPid = await backendPid(reader);
      const pending = blockedQuery(setStatus(writer, ours, batchId, "error", ["finalizing"], "from the former holder"));
      expect((await waitUntilBlocked(monitor, writerPid, readerPid, 5000)).observed).toBe(true);
      await reader.query("COMMIT");
      expect(await pending).toBe("not_owner");
      expect(await batchRow(batchId)).toEqual({ status: "finalizing", error: null });
      await cleanup(writer, ours.msgId);
    } finally {
      // The reader holds the lock the writer may still be waiting on: release it first.
      await reader.end();
      await writer.end();
      await monitor.end();
    }
  });

  test("only the service role can call it", async () => {
    const { batchId } = await seedBatch("ocr");
    for (const role of ["authenticated", "anon"]) {
      const client = await privilegedClient();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        await expect(setStatus(client, { msgId: 1, readCt: 1 }, batchId, "error", ["ocr"])).rejects.toMatchObject({
          code: "42501"
        });
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    }
    const viaApi = await supabase.rpc("exam_worker_set_batch_status", {
      p_msg_id: -1,
      p_read_ct: 1,
      p_batch_id: batchId,
      p_status: "error",
      p_from: ["ocr"]
    });
    expect(viaApi.error).toBeNull();
    expect(viaApi.data).toBe("not_owner");
  });
});

test.describe("a worker that stops renewing hands its message back within the lease (#1158)", () => {
  test("after the lease, a second reader claims the message, and the first reader's token is dead", async () => {
    const { classId, batchId } = await seedBatch("finalizing");
    const a = await privilegedClient();
    const b = await privilegedClient();
    const setVt = async (claim: Pick<Claim, "msgId" | "readCt">, seconds: number) =>
      (
        await a.query<{ ok: boolean }>("SELECT pgmq_public.set_vt_if_claimed('exam_processing', $1, $2, $3) AS ok", [
          claim.msgId,
          claim.readCt,
          seconds
        ])
      ).rows[0].ok;
    const vt = async (msgId: number) =>
      (
        await a.query<{ vt: Date }>("SELECT vt FROM pgmq.q_exam_processing WHERE msg_id = $1", [msgId])
      ).rows[0].vt.getTime();
    try {
      const ours = await queueAndClaim(a, classId, batchId);
      // A stale token renews nothing.
      const before = await vt(ours.msgId);
      expect(await setVt({ msgId: ours.msgId, readCt: ours.readCt - 1 }, 600)).toBe(false);
      expect(await vt(ours.msgId)).toBe(before);
      // The holder's renewal sets a short lease (the worker uses 30 s; 3 s keeps the test quick),
      // replacing the read's 30 s window here and the worker's 120 s one in production.
      expect(await setVt(ours, 3)).toBe(true);
      const renewedAt = Date.now();
      expect(await vt(ours.msgId)).toBeLessThan(renewedAt + 5_000);
      // Reader A stops renewing (its worker died). Until the lease ends, B gets nothing.
      expect(await claimAs(b, ours.tag)).toBeNull();
      // Then the message is claimed again. Usually by B, as the next worker invocation would; on a
      // stack whose cron runs the real worker, that worker can get there first. It then claims this
      // message (read_ct goes up), fails to find scanned row -1 and re-queues a copy with the same
      // tag, which B must not mistake for ours. Either way the message came back within the lease.
      let reclaimedBy: "B" | "the running worker" | null = null;
      while (!reclaimedBy && Date.now() - renewedAt < 15_000) {
        await new Promise((r) => setTimeout(r, 250));
        const theirs = await claimAs(b, ours.tag);
        if (theirs?.msgId === ours.msgId) {
          expect(theirs.readCt).toBe(ours.readCt + 1);
          reclaimedBy = "B";
        } else {
          const { rows } = await a.query<{ read_ct: number }>(
            "SELECT read_ct FROM pgmq.q_exam_processing WHERE msg_id = $1 " +
              "UNION ALL SELECT read_ct FROM pgmq.a_exam_processing WHERE msg_id = $1",
            [ours.msgId]
          );
          if (rows.some((r) => r.read_ct > ours.readCt)) reclaimedBy = "the running worker";
        }
      }
      expect(reclaimedBy).not.toBeNull();
      expect(Date.now() - renewedAt).toBeLessThan(15_000);
      // A's claim is dead: it can neither renew the lease nor move the batch.
      expect(await setVt(ours, 30)).toBe(false);
      expect(await setStatus(a, ours, batchId, "error", ["finalizing"], "from the dead reader")).toBe("not_owner");
      expect(await batchRow(batchId)).toEqual({ status: "finalizing", error: null });
      // Ours, and any copy a running worker re-queued.
      await a.query(
        "SELECT pgmq.archive('exam_processing', msg_id) FROM pgmq.q_exam_processing WHERE message->>'test_tag' = $1",
        [ours.tag]
      );
    } finally {
      await a.end();
      await b.end();
    }
  });
});

test.describe("a leftover finalize does not complete a batch that is back in review (#1158, #1270)", () => {
  // Needs exam-async-worker running (CI's e2e-local serves it).
  test("a redelivered finalize for an exam already finalized leaves a reopened batch in review", async () => {
    const course = await createClass({ name: "Leftover finalize" });
    const grader = await createUserInClass({ role: "grader", class_id: course.id });
    const alice = await createUserInClass({ role: "student", class_id: course.id, name: "Alice Leftover" });
    const bob = await createUserInClass({ role: "student", class_id: course.id, name: "Bob Leftover" });
    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Leftover finalize exam",
      assignment_type: "exam",
      due_date: addDays(new Date(), 7).toISOString()
    });
    const { data: examId } = await supabase.rpc("exam_create", {
      p_assignment_id: assignment.id,
      p_source_type: "pdf",
      p_num_pages: 1
    });
    // As after an earlier run finalized Alice's exam, then Retry put the batch back in review with
    // Bob's exam still undecided.
    const { data: batch } = await supabase
      .from("exam_scan_batches")
      .insert({ class_id: course.id, exam_id: examId as number, total_pages: 2, pages_per_exam: 1, status: "review" })
      .select("id")
      .single();
    const { data: rows, error: rowsErr } = await supabase
      .from("exam_scanned_submissions")
      .insert([
        {
          class_id: course.id,
          exam_id: examId as number,
          batch_id: batch!.id,
          exam_index: 0,
          matched_profile_id: alice.private_profile_id,
          match_status: "confirmed"
        },
        {
          class_id: course.id,
          exam_id: examId as number,
          batch_id: batch!.id,
          exam_index: 1,
          matched_profile_id: bob.private_profile_id,
          match_status: "suggested"
        }
      ])
      .select("id, exam_index")
      .order("exam_index");
    expect(rowsErr).toBeNull();
    const [aliceRow, bobRow] = rows!;
    const { error: createErr } = await supabase.rpc("exam_create_submission", {
      p_scanned_submission_id: aliceRow.id,
      p_expected_profile_id: alice.private_profile_id
    });
    expect(createErr).toBeNull();
    const { data: finalized, error: finalizeErr } = await supabase
      .from("exam_scanned_submissions")
      .update({ finalized_at: new Date().toISOString() })
      .eq("id", aliceRow.id)
      .select("id, finalized_at");
    // Without this the fixture is not what the test claims: a finalize for an unfinalized row with
    // no scan pages throws, is retried, and the archive poll below would pass on the retry alone.
    expect(finalizeErr).toBeNull();
    expect(finalized).toHaveLength(1);
    expect(finalized![0].id).toBe(aliceRow.id);
    expect(finalized![0].finalized_at).not.toBeNull();

    // The earlier run's finalize message for Alice's exam, redelivered.
    const client = await privilegedClient();
    try {
      const { rows: sent } = await client.query<{ id: string }>(
        "SELECT pgmq.send('exam_processing', $1::jsonb) AS id",
        [
          JSON.stringify({
            method: "finalize",
            class_id: course.id,
            batch_id: batch!.id,
            args: { scanned_submission_id: aliceRow.id }
          })
        ]
      );
      const msgId = Number(sent[0].id);
      await expect
        .poll(
          async () => {
            await runExamWorker();
            const { rows: archived } = await client.query("SELECT 1 FROM pgmq.a_exam_processing WHERE msg_id = $1", [
              msgId
            ]);
            return archived.length;
          },
          { timeout: 60_000, intervals: [1000, 2000, 3000] }
        )
        .toBe(1);
      // Handled as already finalized, not failed: no retry of it is queued and nothing was dead-lettered.
      const { rows: again } = await client.query(
        "SELECT msg_id FROM pgmq.q_exam_processing WHERE message->>'method' = 'finalize' " +
          "AND message->'args'->>'scanned_submission_id' = $1::text",
        [aliceRow.id]
      );
      expect(again).toHaveLength(0);
      const { rows: dead } = await client.query(
        "SELECT id FROM public.exam_async_worker_dlq_messages WHERE envelope->'args'->>'scanned_submission_id' = $1::text",
        [aliceRow.id]
      );
      expect(dead).toHaveLength(0);
      // The batch stays in review, so Bob's undecided exam can still be decided.
      expect(await batchRow(batch!.id)).toEqual({ status: "review", error: null });
      await beginAsUser(client, grader.user_id);
      const edit = await client.query(
        "UPDATE public.exam_scanned_submissions SET match_status = 'confirmed' WHERE id = $1 AND match_status = 'suggested'",
        [bobRow.id]
      );
      await client.query("ROLLBACK");
      expect(edit.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});

/** Call a worker function through PostgREST as the service role, with the worker's own argument builder. */
async function callFn<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const rpc = supabase.rpc as unknown as (
    f: string,
    a: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc.call(supabase, fn, args);
  expect(error, `${fn}: ${error?.message}`).toBeNull();
  return data as T;
}

/** The messages of this test still queued, and archived, by tag. */
async function tagged(client: Client, tag: string) {
  const q = await client.query<{ msg_id: string; read_ct: number; vt: Date; message: Record<string, unknown> }>(
    "SELECT msg_id, read_ct, vt, message FROM pgmq.q_exam_processing WHERE message->>'test_tag' = $1 ORDER BY msg_id",
    [tag]
  );
  const a = await client.query<{ msg_id: string }>(
    "SELECT msg_id FROM pgmq.a_exam_processing WHERE message->>'test_tag' = $1 ORDER BY msg_id",
    [tag]
  );
  return { queued: q.rows, archived: a.rows.map((r) => Number(r.msg_id)) };
}

async function dlqRecords(client: Client, tag: string) {
  const queue = await client.query(
    "SELECT msg_id FROM pgmq.q_exam_processing_dlq WHERE message->>'test_tag' = $1 OR message->'malformed_envelope'->>'test_tag' = $1",
    [tag]
  );
  const audit = await client.query<{ method: string | null; envelope: unknown; error_message: string }>(
    "SELECT method, envelope, error_message FROM public.exam_async_worker_dlq_messages " +
      "WHERE envelope->>'test_tag' = $1 OR envelope->'malformed_envelope'->>'test_tag' = $1",
    [tag]
  );
  return { queue: queue.rows.length, audit: audit.rows };
}

async function cleanupTag(client: Client, tag: string) {
  await client.query(
    "SELECT pgmq.archive('exam_processing', msg_id) FROM pgmq.q_exam_processing WHERE message->>'test_tag' = $1",
    [tag]
  );
  await client.query(
    "SELECT pgmq.archive('exam_processing_dlq', msg_id) FROM pgmq.q_exam_processing_dlq WHERE message->>'test_tag' = $1",
    [tag]
  );
}

/**
 * The rest of the ownership boundary (#1158 review): acknowledging, re-queueing and giving up on a
 * message, each only while the caller still holds it (20261122130000; _shared/examWorkerFence.ts).
 * A stale claim is set up the way it happens: our read, our lease lapses, a second read.
 */
test.describe("queue disposition: only the message's current holder acks, re-queues or gives up (#1158)", () => {
  async function staleAndCurrent(client: Client) {
    const { classId, batchId } = await seedBatch("finalizing");
    // Claim, lapse and re-claim in one transaction, so no running worker takes the message between.
    await client.query("BEGIN");
    const ours = await queueAndClaimInTx(client, classId, batchId);
    await lapse(client, ours.msgId);
    const theirs = (await claimAs(client, ours.tag))!;
    // Keep it hidden for the rest of the test.
    await client.query(
      "UPDATE pgmq.q_exam_processing SET vt = clock_timestamp() + interval '1 hour' WHERE msg_id = $1",
      [ours.msgId]
    );
    await client.query("COMMIT");
    expect(theirs.readCt).toBe(ours.readCt + 1);
    return { classId, batchId, stale: ours, current: theirs };
  }

  test("ack: a stale claim archives nothing; the holder's ack archives the message", async () => {
    const client = await privilegedClient();
    try {
      const { stale, current } = await staleAndCurrent(client);
      expect(await callFn("exam_worker_ack", ackArgs(stale))).toBe("not_owner");
      let state = await tagged(client, stale.tag);
      expect(state.queued.map((m) => m.read_ct)).toEqual([current.readCt]);
      expect(state.archived).toEqual([]);
      expect(await callFn("exam_worker_ack", ackArgs(current))).toBe("acked");
      state = await tagged(client, stale.tag);
      expect(state.queued).toEqual([]);
      expect(state.archived).toEqual([current.msgId]);
    } finally {
      await client.end();
    }
  });

  test("requeue: a stale claim sends and archives nothing; the holder's replaces the message in one step", async () => {
    const client = await privilegedClient();
    try {
      const { classId, batchId, stale, current } = await staleAndCurrent(client);
      const replacement = {
        method: "finalize",
        class_id: classId,
        batch_id: batchId,
        args: { scanned_submission_id: -1 },
        test_tag: stale.tag,
        retry_count: 1
      };
      expect(await callFn("exam_worker_requeue", requeueArgs(stale, replacement, 3600, true))).toBe("not_owner");
      let state = await tagged(client, stale.tag);
      expect(state.queued.map((m) => Number(m.msg_id))).toEqual([current.msgId]);
      expect(state.archived).toEqual([]);

      expect(await callFn("exam_worker_requeue", requeueArgs(current, replacement, 3600, true))).toBe("requeued");
      state = await tagged(client, stale.tag);
      expect(state.archived).toEqual([current.msgId]);
      expect(state.queued).toHaveLength(1);
      const [next] = state.queued;
      expect(next.read_ct).toBe(0);
      expect(next.message.retry_count).toBe(1);
      // The stamp is the instant the replacement's own visibility was computed from (ocrWait.ts).
      const stamp = Date.parse(String(next.message.ocr_wait_from));
      expect(next.vt.getTime() - stamp).toBe(3600 * 1000);
    } finally {
      await client.end();
    }
  });

  test("requeue: the stamp is taken after waiting for the claim lock, and nothing is visible before commit", async () => {
    const client = await privilegedClient();
    const blocker = await privilegedClient();
    const monitor = await privilegedClient();
    const observer = await privilegedClient();
    try {
      const { classId, batchId } = await seedBatch("matching");
      const ours = await queueAndClaim(client, classId, batchId);
      const message = {
        method: "match",
        class_id: classId,
        batch_id: batchId,
        args: { batch_id: batchId },
        test_tag: ours.tag
      };
      // A renewal-sized lock on the message row held for 2s: the requeue waits for it.
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM pgmq.q_exam_processing WHERE msg_id = $1 FOR UPDATE", [ours.msgId]);
      const clientPid = await backendPid(client);
      const blockerPid = await backendPid(blocker);
      await client.query("BEGIN");
      const pending = blockedQuery(
        client.query<{ outcome: string }>(
          "SELECT public.exam_worker_requeue($1, $2, $3::jsonb, 3600, true) AS outcome",
          [ours.msgId, ours.readCt, JSON.stringify(message)]
        )
      );
      expect((await waitUntilBlocked(monitor, clientPid, blockerPid, 5000)).observed).toBe(true);
      await new Promise((r) => setTimeout(r, 2000));
      const released = (await blocker.query<{ t: Date }>("SELECT clock_timestamp() AS t")).rows[0].t;
      await blocker.query("COMMIT");
      expect((await pending).rows[0].outcome).toBe("requeued");
      // Uncommitted: another session sees neither the replacement nor the archive.
      let seen = await tagged(observer, ours.tag);
      expect(seen.queued.map((m) => Number(m.msg_id))).toEqual([ours.msgId]);
      expect(seen.archived).toEqual([]);
      await new Promise((r) => setTimeout(r, 1500));
      await client.query("COMMIT");
      seen = await tagged(observer, ours.tag);
      expect(seen.archived).toEqual([ours.msgId]);
      expect(seen.queued).toHaveLength(1);
      const stamp = Date.parse(String(seen.queued[0].message.ocr_wait_from));
      expect(stamp).toBeGreaterThanOrEqual(released.getTime());
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
      await blocker.end();
      await monitor.end();
      await observer.end();
    }
  });

  test("give up: a stale claim changes nothing; the holder's errors the batch, records it twice and archives", async () => {
    const client = await privilegedClient();
    try {
      const { batchId, stale, current } = await staleAndCurrent(client);
      const envelope = { method: "finalize", batch_id: batchId, test_tag: stale.tag, retry_count: 5 };
      const g = { batchId, from: ["finalizing"], error: "gave up", errorType: "Error", envelope };
      expect(await callFn("exam_worker_give_up", giveUpArgs(stale, g))).toBe("not_owner");
      expect(await batchRow(batchId)).toEqual({ status: "finalizing", error: null });
      expect(await dlqRecords(client, stale.tag)).toEqual({ queue: 0, audit: [] });
      expect((await tagged(client, stale.tag)).queued).toHaveLength(1);

      expect(await callFn("exam_worker_give_up", giveUpArgs(current, g))).toBe("given_up");
      expect(await batchRow(batchId)).toEqual({ status: "error", error: "gave up" });
      const dlq = await dlqRecords(client, stale.tag);
      expect(dlq.queue).toBe(1);
      expect(dlq.audit).toHaveLength(1);
      expect(dlq.audit[0]).toMatchObject({ method: "finalize", error_message: "gave up" });
      expect(await tagged(client, stale.tag)).toEqual({ queued: [], archived: [current.msgId] });
    } finally {
      await client.end();
    }
  });

  test("give up: a batch outside the allowed states keeps its status, and the message is still recorded and archived", async () => {
    const client = await privilegedClient();
    try {
      const { batchId, current } = await staleAndCurrent(client);
      // A late give-up for a finalize whose batch has since completed: 'completed' is not in from.
      await supabase.from("exam_scan_batches").update({ status: "completed" }).eq("id", batchId);
      const envelope = { method: "finalize", batch_id: batchId, test_tag: current.tag, retry_count: 5 };
      const g = { batchId, from: ["finalizing"], error: "late give-up", errorType: "Error", envelope };
      expect(await callFn("exam_worker_give_up", giveUpArgs(current, g))).toBe("given_up");
      expect(await batchRow(batchId)).toEqual({ status: "completed", error: null });
      const dlq = await dlqRecords(client, current.tag);
      expect(dlq.queue).toBe(1);
      expect(dlq.audit).toHaveLength(1);
      expect((await tagged(client, current.tag)).archived).toEqual([current.msgId]);
    } finally {
      await client.end();
    }
  });

  test("give up with no batch (a message with no usable envelope): no batch is touched, the message is recorded and archived", async () => {
    const client = await privilegedClient();
    try {
      const { batchId, current } = await staleAndCurrent(client);
      const g = {
        batchId: null,
        from: [],
        error: "no envelope",
        errorType: "Error",
        envelope: { not_an_envelope: true, test_tag: current.tag }
      };
      expect(await callFn("exam_worker_give_up", giveUpArgs(current, g))).toBe("given_up");
      expect(await batchRow(batchId)).toEqual({ status: "finalizing", error: null });
      const dlq = await dlqRecords(client, current.tag);
      expect(dlq.queue).toBe(1);
      expect(dlq.audit[0].method).toBeNull();
      expect((await tagged(client, current.tag)).archived).toEqual([current.msgId]);
    } finally {
      await client.end();
    }
  });

  // Either dead-letter record suffices; only both failing rolls the give-up back. A second session
  // holds the record's table so the insert times out (lock_timeout), inside transactions that roll back.
  for (const blocked of ["queue", "audit", "both"] as const) {
    test(`give up with the ${blocked} record unavailable`, async () => {
      const client = await privilegedClient();
      const blocker = await privilegedClient();
      try {
        const { batchId, current } = await staleAndCurrent(client);
        const envelope = { method: "finalize", batch_id: batchId, test_tag: current.tag };
        await blocker.query("BEGIN");
        if (blocked !== "audit") await blocker.query("LOCK TABLE pgmq.q_exam_processing_dlq IN ACCESS EXCLUSIVE MODE");
        if (blocked !== "queue") {
          await blocker.query("LOCK TABLE public.exam_async_worker_dlq_messages IN ACCESS EXCLUSIVE MODE");
        }
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '200ms'");
        await client.query("SET LOCAL ROLE service_role");
        await client.query("SAVEPOINT before_give_up");
        const call = client.query<{ outcome: string }>(
          "SELECT public.exam_worker_give_up($1, $2, $3, ARRAY['finalizing'], 'gave up', 'Error', $4::jsonb) AS outcome",
          [current.msgId, current.readCt, batchId, JSON.stringify(envelope)]
        );
        if (blocked === "both") {
          await expect(call).rejects.toThrow(/both dead-letter records failed/);
          await client.query("ROLLBACK TO SAVEPOINT before_give_up");
          const { rows } = await client.query("SELECT status FROM public.exam_scan_batches WHERE id = $1", [batchId]);
          expect(rows[0].status).toBe("finalizing");
          const { rows: q } = await client.query("SELECT 1 FROM pgmq.q_exam_processing WHERE msg_id = $1", [
            current.msgId
          ]);
          expect(q).toHaveLength(1);
        } else {
          expect((await call).rows[0].outcome).toBe(
            blocked === "queue" ? "given_up:no_dlq_message" : "given_up:no_audit_row"
          );
          const { rows } = await client.query("SELECT status FROM public.exam_scan_batches WHERE id = $1", [batchId]);
          expect(rows[0].status).toBe("error");
          const { rows: a } = await client.query("SELECT 1 FROM pgmq.a_exam_processing WHERE msg_id = $1", [
            current.msgId
          ]);
          expect(a).toHaveLength(1);
        }
        await client.query("ROLLBACK");
        await blocker.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        await blocker.query("ROLLBACK").catch(() => {});
        await client.end();
        await blocker.end();
      }
    });
  }

  test("claim first: a give-up that waits on a new reader's claim then finds it is not the holder", async () => {
    const { classId, batchId } = await seedBatch("finalizing");
    const writer = await privilegedClient();
    const reader = await privilegedClient();
    const monitor = await privilegedClient();
    try {
      const ours = await queueAndClaim(writer, classId, batchId);
      await reader.query("BEGIN");
      await lapse(reader, ours.msgId);
      const theirs = await claimAs(reader, ours.tag);
      expect(theirs?.readCt).toBe(ours.readCt + 1);
      const writerPid = await backendPid(writer);
      const readerPid = await backendPid(reader);
      const pending = blockedQuery(
        writer.query<{ outcome: string }>(
          "SELECT public.exam_worker_give_up($1, $2, $3, ARRAY['finalizing'], 'stale', 'Error', $4::jsonb) AS outcome",
          [ours.msgId, ours.readCt, batchId, JSON.stringify({ test_tag: ours.tag })]
        )
      );
      expect((await waitUntilBlocked(monitor, writerPid, readerPid, 5000)).observed).toBe(true);
      await reader.query("COMMIT");
      expect((await pending).rows[0].outcome).toBe("not_owner");
      expect(await batchRow(batchId)).toEqual({ status: "finalizing", error: null });
      expect(await dlqRecords(writer, ours.tag)).toEqual({ queue: 0, audit: [] });
    } finally {
      // The reader holds the lock the writer may still be waiting on: release it first.
      await reader.end();
      await writer.end();
      await monitor.end();
    }
  });
});

/**
 * A message the worker can't use leaves the queue the first time it is read, through the real worker
 * (CodeRabbit on #1308). Every producer is a SQL function that writes an integer batch_id; this is the
 * body a bug or a hand-sent message could leave. Give-up passes batch_id to a bigint parameter, so a
 * batch_id that isn't an integer used to make the give-up itself fail and the message came back forever.
 */
test.describe("a message with no usable envelope is dead-lettered on its first read (#1158)", () => {
  test("a batch_id that isn't an integer: recorded and archived at once, and its content stays out of the error", async () => {
    const client = await privilegedClient();
    const tag = `malformed-${randomUUID()}`;
    const secret = `content-${randomUUID()}`;
    try {
      // retry_count 5: had the handler run, its first failure would go straight to give-up.
      const { rows } = await client.query<{ id: string }>("SELECT pgmq.send('exam_processing', $1::jsonb) AS id", [
        JSON.stringify({
          method: "finalize",
          class_id: 1,
          batch_id: "not-a-batch",
          args: { scanned_submission_id: 0 },
          retry_count: 5,
          note: secret,
          test_tag: tag
        })
      ]);
      const msgId = Number(rows[0].id);
      await expect
        .poll(
          async () => {
            await runExamWorker();
            return (await tagged(client, tag)).archived;
          },
          { timeout: 30_000, intervals: [1000, 2000, 3000] }
        )
        .toEqual([msgId]);
      expect((await tagged(client, tag)).queued).toEqual([]);
      const { rows: archived } = await client.query<{ read_ct: number }>(
        "SELECT read_ct FROM pgmq.a_exam_processing WHERE msg_id = $1",
        [msgId]
      );
      expect(archived[0].read_ct).toBe(1);
      const dlq = await dlqRecords(client, tag);
      expect(dlq.queue).toBe(1);
      expect(dlq.audit).toHaveLength(1);
      // The DLQ record keeps the body for whoever investigates; the error, which is also what goes
      // to Sentry, names the problem and not the content.
      expect(dlq.audit[0].envelope).toMatchObject({ note: secret, test_tag: tag });
      expect(dlq.audit[0].error_message).toMatch(/batch_id/);
      expect(dlq.audit[0].error_message).not.toContain(secret);
      expect(dlq.audit[0].error_message).not.toContain("not-a-batch");
    } finally {
      try {
        await cleanupTag(client, tag);
      } finally {
        await client.end();
      }
    }
  });

  // An object with its own toString set to null throws when a log line interpolates it, so a body
  // like this could stop every read in a log line before it reached give-up (CodeRabbit on #1308).
  test("a field that can't be printed doesn't stop the message in a log line, on a first read or a redelivery", async () => {
    const client = await privilegedClient();
    const tag = `unprintable-${randomUUID()}`;
    const unprintable = { toString: null };
    try {
      const send = async (body: Record<string, unknown>) =>
        Number(
          (
            await client.query<{ id: string }>("SELECT pgmq.send('exam_processing', $1::jsonb) AS id", [
              JSON.stringify({ class_id: 1, args: {}, test_tag: tag, ...body })
            ])
          ).rows[0].id
        );
      // First read: a method the handling log would print.
      const badMethod = await send({ method: unprintable, batch_id: 0 });
      // A redelivery (an earlier read ended without a disposition): a batch_id the redelivery log
      // would print before the envelope is checked. Sent with its earlier read in one transaction, so
      // a running worker cannot read it first.
      await client.query("BEGIN");
      const badBatch = await send({ method: "finalize", batch_id: unprintable });
      await client.query("UPDATE pgmq.q_exam_processing SET read_ct = 1 WHERE msg_id = $1", [badBatch]);
      await client.query("COMMIT");

      await expect
        .poll(
          async () => {
            await runExamWorker();
            return (await tagged(client, tag)).archived;
          },
          { timeout: 30_000, intervals: [1000, 2000, 3000] }
        )
        .toEqual([badMethod, badBatch]);
      const { rows: reads } = await client.query<{ msg_id: string; read_ct: number }>(
        "SELECT msg_id, read_ct FROM pgmq.a_exam_processing WHERE msg_id = ANY($1::bigint[]) ORDER BY msg_id",
        [[badMethod, badBatch]]
      );
      expect(reads.map((r) => r.read_ct)).toEqual([1, 2]);
      const errors = (await dlqRecords(client, tag)).audit.map((a) => a.error_message);
      expect(errors).toHaveLength(2);
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(`msg ${badMethod} .*method is not a string \\(object\\)`)),
          expect.stringMatching(new RegExp(`msg ${badBatch} .*batch_id is not an integer \\(object\\)`))
        ])
      );
    } finally {
      try {
        await cleanupTag(client, tag);
      } finally {
        await client.end();
      }
    }
  });

  // retry_count bounds the retries. An object that can't be printed threw in the attempt tag before
  // the poison-pill guard, on every read; a large negative count retried with no delay and a fresh
  // read count each time; a string made the backoff NaN, so the re-queue failed on every read until
  // the read limit (CodeRabbit on #1308).
  test("a retry_count that isn't a nonnegative integer is dead-lettered on its first read", async () => {
    const client = await privilegedClient();
    const tag = `bad-retry-${randomUUID()}`;
    try {
      const send = async (retryCount: unknown) =>
        Number(
          (
            await client.query<{ id: string }>("SELECT pgmq.send('exam_processing', $1::jsonb) AS id", [
              // A page that doesn't exist: had the handler run, it would fail into the retry path.
              JSON.stringify({
                method: "process_page",
                class_id: 1,
                batch_id: 0,
                args: { scan_page_id: -1 },
                retry_count: retryCount,
                test_tag: tag
              })
            ])
          ).rows[0].id
        );
      const asString = await send("four");
      const negative = await send(-1_000_000);
      const unprintable = await send({ toString: null });
      await expect
        .poll(
          async () => {
            await runExamWorker();
            return (await tagged(client, tag)).archived;
          },
          { timeout: 30_000, intervals: [1000, 2000, 3000] }
        )
        .toEqual([asString, negative, unprintable]);
      // Nothing re-queued in their place.
      expect((await tagged(client, tag)).queued).toEqual([]);
      const errors = (await dlqRecords(client, tag)).audit.map((a) => a.error_message);
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(`msg ${asString} .*retry_count is not a nonnegative integer \\(string\\)`)),
          expect.stringMatching(new RegExp(`msg ${negative} .*retry_count is not a nonnegative integer \\(number\\)`)),
          expect.stringMatching(
            new RegExp(`msg ${unprintable} .*retry_count is not a nonnegative integer \\(object\\)`)
          )
        ])
      );
      expect(errors).toHaveLength(3);
    } finally {
      try {
        await cleanupTag(client, tag);
      } finally {
        await client.end();
      }
    }
  });

  // A body whose batch_id and method are usable still names a batch that may be waiting on it. Only
  // its retry_count is malformed here: it is dead-lettered on its first read as before, and its
  // batch is errored from the finalize phase, as any finalize give-up would, so it isn't left in
  // 'finalizing' with nothing queued (CodeRabbit 6017515539).
  test("a malformed retry_count on a finalize for a real batch errors that batch, from its phase only", async () => {
    const client = await privilegedClient();
    const tag = `bad-retry-final-${randomUUID()}`;
    try {
      const { classId, batchId } = await seedBatch("finalizing");
      const { rows } = await client.query<{ id: string }>("SELECT pgmq.send('exam_processing', $1::jsonb) AS id", [
        JSON.stringify({
          method: "finalize",
          class_id: classId,
          batch_id: batchId,
          args: { scanned_submission_id: -1 },
          retry_count: "5",
          test_tag: tag
        })
      ]);
      const msgId = Number(rows[0].id);
      await expect
        .poll(
          async () => {
            await runExamWorker();
            return (await tagged(client, tag)).archived;
          },
          { timeout: 30_000, intervals: [1000, 2000, 3000] }
        )
        .toEqual([msgId]);
      expect((await tagged(client, tag)).queued).toEqual([]);
      const batch = await batchRow(batchId);
      expect(batch?.status).toBe("error");
      expect(batch?.error).toMatch(new RegExp(`msg ${msgId} .*retry_count is not a nonnegative integer \\(string\\)`));
      const dlq = await dlqRecords(client, tag);
      expect(dlq.queue).toBe(1);
      expect(dlq.audit).toHaveLength(1);
    } finally {
      try {
        await cleanupTag(client, tag);
      } finally {
        await client.end();
      }
    }
  });
});

/**
 * Match results (links and suggestions) are written only while the worker holds its match message
 * and the batch is still 'matching', and never over a human decision (#1158 review).
 */
test.describe("match writes: only the holder, only while matching, never over a decision (#1158)", () => {
  async function matchingBatch(pages: number) {
    const { classId, examId, batchId } = await seedBatch("matching");
    await supabase.from("exam_scan_batches").update({ total_pages: pages, pages_per_exam: 1 }).eq("id", batchId);
    const ids: number[] = [];
    for (let i = 0; i < pages; i++) {
      const { data, error } = await supabase
        .from("exam_scan_pages")
        .insert({
          class_id: classId,
          exam_id: examId,
          batch_id: batchId,
          page_index: i,
          image_path: `classes/${classId}/exams/${examId}/batches/${batchId}/page-${i}.png`,
          width: 1000,
          height: 1400
        })
        .select("id")
        .single();
      expect(error).toBeNull();
      ids.push(data!.id);
    }
    const student = await createUserInClass({ role: "student", class_id: classId });
    return { classId, batchId, pages: ids, profileId: student.private_profile_id };
  }
  const groupsOf = (pageIds: number[]) => pageIds.map((id, i) => ({ exam_index: i, page_ids: [id] }));
  async function rows(batchId: number) {
    const { data, error } = await supabase
      .from("exam_scanned_submissions")
      .select("id, exam_index, match_status, matched_profile_id, match_confidence, detected_name")
      .eq("batch_id", batchId)
      .order("exam_index");
    expect(error, error?.message).toBeNull();
    return data!;
  }
  const suggestion = (profileId: string | null, pageIds: number[]) => ({
    detectedName: "Detected Name",
    detectedSisId: null,
    matchedProfileId: profileId,
    confidence: profileId ? 0.9 : 0,
    pageIds
  });
  /** Staff, through the database API as a grader: a page ahead of the others, and total_pages to match. */
  async function addPageFirst(classId: number, batchId: number, pages: number) {
    const grader = await createUserInClass({ role: "grader", class_id: classId });
    const asGrader = await createAuthenticatedClient(grader);
    const { data: batch } = await supabase.from("exam_scan_batches").select("exam_id").eq("id", batchId).single();
    const { data, error } = await asGrader
      .from("exam_scan_pages")
      .insert({
        class_id: classId,
        exam_id: batch!.exam_id,
        batch_id: batchId,
        page_index: -1,
        image_path: `classes/${classId}/exams/${batch!.exam_id}/batches/${batchId}/page-added.png`,
        width: 1000,
        height: 1400
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const bump = await asGrader
      .from("exam_scan_batches")
      .update({ total_pages: pages + 1 })
      .eq("id", batchId)
      .select("id");
    expect(bump.data).toHaveLength(1);
    return data!.id;
  }
  async function pagesOf(rowId: number) {
    const { data } = await supabase.from("exam_scan_pages").select("id").eq("scanned_submission_id", rowId).order("id");
    return (data ?? []).map((p) => p.id);
  }

  test("link: a stale claim links nothing; a batch past matching links nothing; the holder links", async () => {
    const client = await privilegedClient();
    try {
      const { classId, batchId, pages } = await matchingBatch(2);
      await client.query("BEGIN");
      const stale = await queueAndClaimInTx(client, classId, batchId);
      await lapse(client, stale.msgId);
      const current = (await claimAs(client, stale.tag))!;
      await client.query("COMMIT");
      expect(await callFn("exam_worker_link_scan_groups", linkArgs(stale, batchId, groupsOf(pages)))).toEqual({
        outcome: "not_owner"
      });
      expect(await rows(batchId)).toEqual([]);
      await supabase.from("exam_scan_batches").update({ status: "review" }).eq("id", batchId);
      expect(await callFn("exam_worker_link_scan_groups", linkArgs(current, batchId, groupsOf(pages)))).toEqual({
        outcome: "state_changed"
      });
      expect(await rows(batchId)).toEqual([]);
      await supabase.from("exam_scan_batches").update({ status: "matching" }).eq("id", batchId);
      const linked = await callFn<{ outcome: string; rows: unknown[] }>(
        "exam_worker_link_scan_groups",
        linkArgs(current, batchId, groupsOf(pages))
      );
      expect(linked.outcome).toBe("applied");
      expect(linked.rows).toHaveLength(2);
      expect(await rows(batchId)).toHaveLength(2);
    } finally {
      await client.end();
    }
  });

  test("suggestion: only the holder, only while matching, never over a confirmed, skipped or picked exam", async () => {
    const client = await privilegedClient();
    try {
      const { classId, batchId, pages, profileId } = await matchingBatch(4);
      await client.query("BEGIN");
      const stale = await queueAndClaimInTx(client, classId, batchId);
      await lapse(client, stale.msgId);
      const current = (await claimAs(client, stale.tag))!;
      await client.query("COMMIT");
      await callFn("exam_worker_link_scan_groups", linkArgs(current, batchId, groupsOf(pages)));
      const [fresh, confirmed, skipped, picked] = await rows(batchId);
      await supabase
        .from("exam_scanned_submissions")
        .update({ match_status: "confirmed", matched_profile_id: profileId, match_confidence: 1 })
        .eq("id", confirmed.id);
      await supabase.from("exam_scanned_submissions").update({ match_status: "skipped" }).eq("id", skipped.id);
      // A staff pick in review: suggested, with no confidence (MatchReview.tsx).
      await supabase
        .from("exam_scanned_submissions")
        .update({ match_status: "suggested", matched_profile_id: profileId, match_confidence: null })
        .eq("id", picked.id);
      const before = await rows(batchId);

      const write = async (claim: { msgId: number; readCt: number }, id: number) =>
        callFn(
          "exam_worker_set_match_suggestion",
          suggestionArgs(claim, batchId, id, suggestion(profileId, await pagesOf(id)))
        );
      expect(await write(stale, fresh.id)).toBe("not_owner");
      expect(await rows(batchId)).toEqual(before);
      await supabase.from("exam_scan_batches").update({ status: "review" }).eq("id", batchId);
      expect(await write(current, fresh.id)).toBe("state_changed");
      expect(await rows(batchId)).toEqual(before);
      await supabase.from("exam_scan_batches").update({ status: "matching" }).eq("id", batchId);
      for (const decided of [confirmed, skipped, picked]) expect(await write(current, decided.id)).toBe("skipped");
      expect(await rows(batchId)).toEqual(before);
      expect(await write(current, fresh.id)).toBe("applied");
      const after = await rows(batchId);
      expect(after[0]).toMatchObject({
        match_status: "suggested",
        matched_profile_id: profileId,
        detected_name: "Detected Name"
      });
      expect(after.slice(1)).toEqual(before.slice(1));
    } finally {
      await client.end();
    }
  });

  test("a staff pick survives a re-link that keeps its pages, and is cleared by one that changes them", async () => {
    const client = await privilegedClient();
    try {
      const { classId, batchId, pages, profileId } = await matchingBatch(2);
      const ours = await queueAndClaim(client, classId, batchId);
      await callFn("exam_worker_link_scan_groups", linkArgs(ours, batchId, groupsOf(pages)));
      const [first] = await rows(batchId);
      await supabase
        .from("exam_scanned_submissions")
        .update({ match_status: "suggested", matched_profile_id: profileId, match_confidence: null })
        .eq("id", first.id);

      // Same pages (a re-Process of an unchanged scan): the pick stays, and the worker leaves it.
      await callFn("exam_worker_link_scan_groups", linkArgs(ours, batchId, groupsOf(pages)));
      expect(
        await callFn(
          "exam_worker_set_match_suggestion",
          suggestionArgs(ours, batchId, first.id, suggestion(null, [pages[0]]))
        )
      ).toBe("skipped");
      expect((await rows(batchId))[0]).toMatchObject({
        match_status: "suggested",
        matched_profile_id: profileId,
        match_confidence: null
      });

      // Other pages on that exam (staff added a page ahead of the others): the pick described other
      // paper, so the link clears it (exam_link_scan_groups step 4) and the worker suggests afresh.
      const added = await addPageFirst(classId, batchId, pages.length);
      await callFn("exam_worker_link_scan_groups", linkArgs(ours, batchId, groupsOf([added, ...pages])));
      expect((await rows(batchId))[0]).toMatchObject({
        match_status: "unmatched",
        matched_profile_id: null,
        match_confidence: null
      });
      expect(
        await callFn(
          "exam_worker_set_match_suggestion",
          suggestionArgs(ours, batchId, first.id, suggestion(profileId, [added]))
        )
      ).toBe("applied");
    } finally {
      await client.end();
    }
  });
});

/**
 * A match left over from an earlier Process run holds its own message validly, beside the newer run's
 * (the fence is per message): run 1's match re-queued while waiting for OCR, the batch errored, and
 * staff clicked Process again before it was read. If staff changed the batch's pages in between, the
 * leftover's link and suggestions describe pages as they were. Each is refused, and the newer run
 * finishes every exam (#1158 review, CodeRabbit 6016517634). A refused link is acknowledged only while
 * another match message for the batch is queued; the last one left gives up instead, so the batch
 * goes to error and Process restarts it (CodeRabbit 6017515539; investigations H1).
 */
test.describe("a match from an earlier run cannot write over a newer run's grouping (#1158)", () => {
  async function matchingBatch(pages: number) {
    const { classId, examId, batchId } = await seedBatch("matching");
    const resized = await supabase
      .from("exam_scan_batches")
      .update({ total_pages: pages, pages_per_exam: 1 })
      .eq("id", batchId)
      .select("id");
    expect(resized.error).toBeNull();
    expect(resized.data).toHaveLength(1);
    const ids: number[] = [];
    for (let i = 0; i < pages; i++) {
      const { data, error } = await supabase
        .from("exam_scan_pages")
        .insert({
          class_id: classId,
          exam_id: examId,
          batch_id: batchId,
          page_index: i,
          image_path: `classes/${classId}/exams/${examId}/batches/${batchId}/page-${i}.png`,
          width: 1000,
          height: 1400
        })
        .select("id")
        .single();
      expect(error).toBeNull();
      ids.push(data!.id);
    }
    const grader = await createUserInClass({ role: "grader", class_id: classId });
    const student = await createUserInClass({ role: "student", class_id: classId });
    return { classId, examId, batchId, pages: ids, grader, profileId: student.private_profile_id };
  }
  type Batch = Awaited<ReturnType<typeof matchingBatch>>;
  /**
   * Two match messages for the batch (an earlier run's and a newer run's), each claimed the way the
   * worker claims, and hidden for an hour in the same transaction, so no running worker can take
   * either while the grader edits the batch.
   */
  async function twoMatchClaims(client: Client, b: Batch): Promise<[Claim, Claim]> {
    await client.query("BEGIN");
    const claims: Claim[] = [];
    for (let i = 0; i < 2; i++) {
      const tag = randomUUID();
      queuedTags.add(tag);
      const sent = await client.query<{ id: string }>("SELECT pgmq.send('exam_processing', $1::jsonb) AS id", [
        JSON.stringify({
          method: "match",
          class_id: b.classId,
          batch_id: b.batchId,
          args: { batch_id: b.batchId },
          test_tag: tag
        })
      ]);
      const claim = (await claimAs(client, tag))!;
      expect(claim.msgId).toBe(Number(sent.rows[0].id));
      await client.query(
        "UPDATE pgmq.q_exam_processing SET vt = clock_timestamp() + interval '1 hour' WHERE msg_id = $1",
        [claim.msgId]
      );
      claims.push(claim);
    }
    await client.query("COMMIT");
    return [claims[0], claims[1]];
  }
  const groupsOf = (pageIds: number[]) => pageIds.map((id, i) => ({ exam_index: i, page_ids: [id] }));
  const suggestion = (name: string, profileId: string, pageIds: number[]) => ({
    detectedName: name,
    detectedSisId: null,
    matchedProfileId: profileId,
    confidence: 0.9,
    pageIds
  });
  /** Each exam of the batch with the pages linked to it now. A failed read fails the test. */
  async function exams(batchId: number) {
    const { data, error } = await supabase
      .from("exam_scanned_submissions")
      .select("id, exam_index, match_status, detected_name, matched_profile_id, exam_scan_pages(id)")
      .eq("batch_id", batchId)
      .order("exam_index");
    expect(error, error?.message).toBeNull();
    expect(data).not.toBeNull();
    return data!.map((r) => ({
      id: r.id,
      exam_index: r.exam_index,
      match_status: r.match_status,
      detected_name: r.detected_name,
      matched_profile_id: r.matched_profile_id,
      pages: (r.exam_scan_pages as { id: number }[]).map((p) => p.id).sort((x, y) => x - y)
    }));
  }
  /** Staff, through the database API as the grader: a page ahead of the others, and total_pages to match. */
  async function addPageFirst(b: Batch) {
    const asGrader = await createAuthenticatedClient(b.grader);
    const { data, error } = await asGrader
      .from("exam_scan_pages")
      .insert({
        class_id: b.classId,
        exam_id: b.examId,
        batch_id: b.batchId,
        page_index: -1,
        image_path: `classes/${b.classId}/exams/${b.examId}/batches/${b.batchId}/page-added.png`,
        width: 1000,
        height: 1400
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const bump = await asGrader
      .from("exam_scan_batches")
      .update({ total_pages: b.pages.length + 1 })
      .eq("id", b.batchId)
      .select("id");
    expect(bump.error).toBeNull();
    expect(bump.data).toHaveLength(1);
    return data!.id;
  }
  /**
   * The newer run suggests for exactly the exams it linked (`linked`: their ids and pages), then moves
   * the batch to review; every one of those exams, and no other, ends suggested by it.
   */
  async function newerRunFinishes(client: Client, newer: Claim, b: Batch, linked: { id: number; pages: number[] }[]) {
    expect(linked.length).toBeGreaterThan(0);
    expect((await exams(b.batchId)).map((e) => ({ id: e.id, pages: e.pages }))).toEqual(linked);
    for (const e of linked) {
      expect(
        await callFn(
          "exam_worker_set_match_suggestion",
          suggestionArgs(newer, b.batchId, e.id, suggestion("newer run", b.profileId, e.pages))
        )
      ).toBe("applied");
    }
    expect(await setStatus(client, newer, b.batchId, "review", ["uploaded", "ocr", "matching"])).toBe("applied");
    expect(await exams(b.batchId)).toEqual(
      linked.map((e, i) => ({
        id: e.id,
        exam_index: i,
        match_status: "suggested",
        detected_name: "newer run",
        matched_profile_id: b.profileId,
        pages: e.pages
      }))
    );
    expect((await batchRow(b.batchId))?.status).toBe("review");
  }
  /** Every message for the batch still in the queue table, visible or not. */
  async function queuedFor(client: Client, batchId: number) {
    const { rows } = await client.query<{ msg_id: string; method: string }>(
      "SELECT msg_id, message->>'method' AS method FROM pgmq.q_exam_processing WHERE message->>'batch_id' = $1::text ORDER BY msg_id",
      [batchId]
    );
    return rows.map((r) => ({ msgId: Number(r.msg_id), method: r.method }));
  }

  test("a suggestion read from pages its exam no longer holds is refused", async () => {
    const client = await privilegedClient();
    try {
      const b = await matchingBatch(2);
      const [older, newer] = await twoMatchClaims(client, b);
      // The older run links, and reads identity for exam 0 from page 0.
      expect(
        (
          await callFn<{ outcome: string }>(
            "exam_worker_link_scan_groups",
            linkArgs(older, b.batchId, groupsOf(b.pages))
          )
        ).outcome
      ).toBe("applied");
      const before = await exams(b.batchId);
      expect(before.map((e) => e.pages)).toEqual([[b.pages[0]], [b.pages[1]]]);
      const exam0 = before[0];
      // Staff add a page ahead of the others; the newer run links the grouping that gives.
      const added = await addPageFirst(b);
      expect(
        (
          await callFn<{ outcome: string }>(
            "exam_worker_link_scan_groups",
            linkArgs(newer, b.batchId, groupsOf([added, ...b.pages]))
          )
        ).outcome
      ).toBe("applied");
      const relinked = await exams(b.batchId);
      expect(relinked.map((e) => e.pages)).toEqual([[added], [b.pages[0]], [b.pages[1]]]);
      expect(relinked[0]).toMatchObject({ id: exam0.id, match_status: "unmatched" });

      // The older run's suggestion for exam 0, read from page 0, which exam 0 no longer holds.
      expect(await holds(client, older)).toBe(true);
      expect(
        await callFn(
          "exam_worker_set_match_suggestion",
          suggestionArgs(older, b.batchId, exam0.id, suggestion("older run", b.profileId, [b.pages[0]]))
        )
      ).toBe("state_changed");
      expect(await exams(b.batchId)).toEqual(relinked);
      await newerRunFinishes(
        client,
        newer,
        b,
        relinked.map((e) => ({ id: e.id, pages: e.pages }))
      );
    } finally {
      await client.end();
    }
  });

  test("a link of the grouping read before staff changed the pages is refused, and the newer run finishes", async () => {
    const client = await privilegedClient();
    try {
      const b = await matchingBatch(2);
      const [older, newer] = await twoMatchClaims(client, b);
      // The older run grouped the pages it loaded; before it links, staff add a page and the newer
      // run links the new grouping.
      const olderGroups = groupsOf(b.pages);
      const added = await addPageFirst(b);
      expect(
        (
          await callFn<{ outcome: string }>(
            "exam_worker_link_scan_groups",
            linkArgs(newer, b.batchId, groupsOf([added, ...b.pages]))
          )
        ).outcome
      ).toBe("applied");
      const linked = await exams(b.batchId);
      expect(linked.map((e) => e.pages)).toEqual([[added], [b.pages[0]], [b.pages[1]]]);

      // Linked, this put page 0 back on exam 0 beside the added page and left exam 2 with none. The
      // newer run's message is still queued, so the older one is told to stop, not to give up.
      expect(await holds(client, older)).toBe(true);
      expect(await callFn("exam_worker_link_scan_groups", linkArgs(older, b.batchId, olderGroups))).toEqual({
        outcome: "state_changed"
      });
      expect(await exams(b.batchId)).toEqual(linked);
      expect((await batchRow(b.batchId))?.status).toBe("matching");
      await newerRunFinishes(
        client,
        newer,
        b,
        linked.map((e) => ({ id: e.id, pages: e.pages }))
      );
    } finally {
      await client.end();
    }
  });

  test("when the last match message left finds the pages changed, it gives up and Process restarts the batch", async () => {
    const client = await privilegedClient();
    try {
      const b = await matchingBatch(2);
      const [older, newer] = await twoMatchClaims(client, b);
      // Both grouped the pages before the grader changed them.
      const stale = groupsOf(b.pages);
      const added = await addPageFirst(b);

      // The older one: another match message (the newer) is queued, so it stops.
      expect(await callFn("exam_worker_link_scan_groups", linkArgs(older, b.batchId, stale))).toEqual({
        outcome: "state_changed"
      });
      expect(await callFn("exam_worker_ack", { p_msg_id: older.msgId, p_read_ct: older.readCt })).toBe("acked");
      expect(await queuedFor(client, b.batchId)).toEqual([{ msgId: newer.msgId, method: "match" }]);

      // The newer one is now the only match message: its refusal says so.
      expect(await callFn("exam_worker_link_scan_groups", linkArgs(newer, b.batchId, stale))).toEqual({
        outcome: "pages_changed"
      });
      expect(await exams(b.batchId)).toEqual([]);
      // What the worker then does (PagesChangedError): give up from 'matching' only.
      expect(
        await callFn(
          "exam_worker_give_up",
          giveUpArgs(newer, {
            batchId: b.batchId,
            from: PAGES_CHANGED_ERROR_FROM,
            error: "its pages changed while it was being matched; process the batch again",
            errorType: "PagesChangedError",
            envelope: { method: "match", batch_id: b.batchId }
          })
        )
      ).toBe("given_up");
      expect(await batchRow(b.batchId)).toEqual({
        status: "error",
        error: "its pages changed while it was being matched; process the batch again"
      });
      expect(await queuedFor(client, b.batchId)).toEqual([]);

      // Staff can restart it: Process (as the grader, rolled back so no worker runs it) queues OCR for
      // every page, the added one included, and one match.
      await beginAsUser(client, b.grader.user_id);
      try {
        const { rows } = await client.query<{ n: number }>("SELECT public.enqueue_exam_process_batch($1) AS n", [
          b.batchId
        ]);
        expect(rows[0].n).toBe(3);
        await client.query("RESET ROLE");
        const sent = await client.query<{ method: string; page: string | null }>(
          "SELECT message->>'method' AS method, message->'args'->>'scan_page_id' AS page FROM pgmq.q_exam_processing WHERE message->>'batch_id' = $1::text ORDER BY msg_id",
          [b.batchId]
        );
        expect(
          sent.rows
            .filter((r) => r.method === "process_page")
            .map((r) => Number(r.page))
            .sort((x, y) => x - y)
        ).toEqual([added, ...b.pages].sort((x, y) => x - y));
        expect(sent.rows.filter((r) => r.method === "match")).toHaveLength(1);
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      await client.end();
    }
  });
});

/** Create cannot queue a batch's finalize messages while earlier ones are still queued (#1158 review; N4). */
test.describe("Create refuses a batch that is already creating submissions (#1158)", () => {
  test("Create queues nothing while the batch's finalize messages are queued, and restarts it once they are gone", async () => {
    const { classId, examId, batchId } = await seedBatch("review");
    const student = await createUserInClass({ role: "student", class_id: classId });
    // One confirmed exam with no pages: finalize will fail on it, which is fine here. The batch is
    // all this test looks at.
    const { error: insErr } = await supabase.from("exam_scanned_submissions").insert({
      class_id: classId,
      exam_id: examId,
      batch_id: batchId,
      exam_index: 0,
      match_status: "confirmed",
      matched_profile_id: student.private_profile_id
    });
    expect(insErr).toBeNull();
    const first = await privilegedClient();
    const second = await privilegedClient();
    const monitor = await privilegedClient();
    const queuedFor = async () =>
      (
        await monitor.query(
          "SELECT count(*)::int AS n FROM pgmq.q_exam_processing WHERE message->>'batch_id' = $1::text",
          [batchId]
        )
      ).rows[0].n;
    try {
      const firstPid = await backendPid(first);
      const secondPid = await backendPid(second);
      await first.query("BEGIN");
      expect((await first.query("SELECT public.enqueue_exam_finalize($1) AS n", [batchId])).rows[0].n).toBe(1);
      const waiting = blockedQuery(second.query("SELECT public.enqueue_exam_finalize($1) AS n", [batchId]));
      expect((await waitUntilBlocked(monitor, secondPid, firstPid, 5000)).observed).toBe(true);
      // Keep the first Create's message hidden from running workers, then commit it.
      await first.query(
        "UPDATE pgmq.q_exam_processing SET vt = clock_timestamp() + interval '1 hour' WHERE message->>'batch_id' = $1::text",
        [batchId]
      );
      await first.query("COMMIT");
      await expect(waiting).rejects.toThrow(/already creating submissions/);
      expect(await queuedFor()).toBe(1);
      await expect(second.query("SELECT public.enqueue_exam_finalize($1)", [batchId])).rejects.toThrow(
        /already creating submissions/
      );
      expect(await queuedFor()).toBe(1);
      expect(await batchRow(batchId)).toEqual({ status: "finalizing", error: null });

      // Create once more inside a transaction, hiding what it queued, then commit; "n" is what it queued.
      const createHidden = async () => {
        await second.query("BEGIN");
        const n = (await second.query("SELECT public.enqueue_exam_finalize($1) AS n", [batchId])).rows[0].n;
        await second.query(
          "UPDATE pgmq.q_exam_processing SET vt = clock_timestamp() + interval '1 hour' WHERE message->>'batch_id' = $1::text",
          [batchId]
        );
        await second.query("COMMIT");
        return n;
      };
      const drop = () =>
        monitor.query(
          "SELECT pgmq.archive('exam_processing', msg_id) FROM pgmq.q_exam_processing WHERE message->>'batch_id' = $1::text",
          [batchId]
        );

      // A batch that errored while another exam's finalize is still queued is refused too.
      await supabase.from("exam_scan_batches").update({ status: "error", error: "one exam gave up" }).eq("id", batchId);
      await expect(second.query("SELECT public.enqueue_exam_finalize($1)", [batchId])).rejects.toThrow(
        /already creating submissions/
      );
      expect(await queuedFor()).toBe(1);

      // With no finalize for this batch queued, Create works, whatever else is queued: another
      // method for this batch, or another batch's finalize. Hidden, so no worker runs them.
      await drop();
      const other = await seedBatch("review");
      const unrelated = await monitor.query<{ id: string }>(
        "SELECT pgmq.send('exam_processing', m, 3600) AS id FROM (VALUES " +
          "(jsonb_build_object('method','match','class_id',$1::bigint,'batch_id',$2::bigint,'args',jsonb_build_object('batch_id',$2::bigint)))," +
          "(jsonb_build_object('method','finalize','class_id',$3::bigint,'batch_id',$4::bigint,'args',jsonb_build_object('scanned_submission_id',-1)))" +
          ") AS v(m)",
        [classId, batchId, other.classId, other.batchId]
      );
      try {
        // On the errored batch, with no finalize of its own queued, Create works.
        expect(await createHidden()).toBe(1);
      } finally {
        await monitor.query("SELECT pgmq.archive('exam_processing', id::bigint) FROM unnest($1::text[]) AS id", [
          unrelated.rows.map((r) => r.id)
        ]);
      }
      expect(await batchRow(batchId)).toEqual({ status: "finalizing", error: null });
      // A batch left in 'finalizing' with nothing behind it can still be restarted.
      await drop();
      expect(await batchRow(batchId)).toEqual({ status: "finalizing", error: null });
      expect(await createHidden()).toBe(1);
    } finally {
      await first.query("ROLLBACK").catch(() => {});
      await second.query("ROLLBACK").catch(() => {});
      await monitor.query(
        "SELECT pgmq.archive('exam_processing', msg_id) FROM pgmq.q_exam_processing WHERE message->>'batch_id' = $1::text",
        [batchId]
      );
      await first.end();
      await second.end();
      await monitor.end();
    }
  });
});

/**
 * A reader whose lease lapsed keeps running. Before #1158's review it could archive, re-queue or
 * dead-letter the message by msg_id while a newer reader held it. Now each of those is refused
 * (exam_worker_ack / _requeue / _give_up). These run an expired holder A's three endings against the
 * real worker B holding the message, and check that A changes nothing and B finishes alone.
 *
 * Interleaving: A claims the message and lets its lease lapse; a row lock on the page makes B, once
 * it has claimed the message, read the page and called the provider, wait at its OCR write; A then
 * acts, and B carries on. Needs exam-async-worker running (CI's e2e-local serves it) with the fake
 * vision provider.
 */
test.describe("an expired holder cannot end the newer holder's message (#1158)", () => {
  type Base = {
    a: Client;
    tag: string;
    msgId: number;
    pageId: number;
    batchId: number;
    classId: number;
    envelope: Record<string, unknown>;
  };
  type Race = Base & { lock: Client; workerPid: number };

  /**
   * Set up the race up to the point where B waits at its OCR write and A is free to act. If setup
   * fails, everything it opened is rolled back and closed before the error is rethrown; once it
   * returns, the caller's end() does that.
   */
  async function raceToOcrWrite(label: string, beforeLapse?: (base: Base) => Promise<void>): Promise<Race> {
    // A batch in OCR with one uploaded page, at a path inside the batch's scope (#1078).
    const { classId, examId, batchId } = await seedBatch("ocr");
    const path = `classes/${classId}/exams/${examId}/batches/${batchId}/sis-1__name-${label.replace(/\W+/g, "_")}__page-0.png`;
    const up = await supabase.storage
      .from("exam-scans")
      .upload(path, PNG_1x1, { contentType: "image/png", upsert: true });
    expect(up.error).toBeNull();
    const { data: page, error: pageErr } = await supabase
      .from("exam_scan_pages")
      .insert({
        class_id: classId,
        exam_id: examId,
        batch_id: batchId,
        page_index: 0,
        image_path: path,
        width: 1000,
        height: 1400
      })
      .select("id")
      .single();
    expect(pageErr).toBeNull();
    const tag = randomUUID();
    const envelope = {
      method: "process_page",
      class_id: classId,
      batch_id: batchId,
      args: { scan_page_id: page!.id },
      test_tag: tag
    };
    const a = await privilegedClient();
    const lock = await privilegedClient();
    try {
      // A sends and claims in one transaction, so no running worker sees the message unclaimed.
      await a.query("BEGIN");
      const sent = await a.query<{ id: string }>("SELECT pgmq.send('exam_processing', $1::jsonb) AS id", [
        JSON.stringify(envelope)
      ]);
      const claimA = await claimAs(a, tag);
      await a.query("COMMIT");
      const msgId = Number(sent.rows[0].id);
      expect(claimA).toEqual({ msgId, readCt: 1, tag });
      const base: Base = { a, tag, msgId, pageId: page!.id, batchId, classId, envelope };
      await beforeLapse?.(base);

      await lock.query("BEGIN");
      await lock.query("SELECT 1 FROM public.exam_scan_pages WHERE id = $1 FOR UPDATE", [page!.id]);
      const lockPid = await backendPid(lock);
      await lapse(a, msgId);
      // B: the worker claims the message (read_ct 2), reads the page, OCRs it, and waits on our lock.
      let workerPid: number | undefined;
      const start = Date.now();
      let lastRun = 0;
      while (!workerPid && Date.now() - start < 45_000) {
        if (Date.now() - lastRun > 5_000) {
          lastRun = Date.now();
          await runExamWorker();
        }
        const { rows } = await a.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))",
          [lockPid]
        );
        workerPid = rows[0]?.pid;
        if (!workerPid) await new Promise((r) => setTimeout(r, 100));
      }
      expect(workerPid, "the worker never reached its OCR write").toBeDefined();
      const { rows: held } = await a.query<{ read_ct: number }>(
        "SELECT read_ct FROM pgmq.q_exam_processing WHERE msg_id = $1",
        [msgId]
      );
      expect(held[0]?.read_ct, "B holds the message with the next read").toBe(2);
      return { ...base, lock, workerPid: workerPid! };
    } catch (error) {
      await end({ a, lock, tag } as Race);
      throw error;
    }
  }

  /** Let B's OCR write go, then wait until B has finished with the message (it is no longer queued). */
  async function releaseAndWaitForB(r: Race) {
    await r.lock.query("COMMIT");
    await expect.poll(async () => (await tagged(r.a, r.tag)).queued.length, { timeout: 30_000 }).toBe(0);
  }

  async function pageOcr(pageId: number) {
    const { data, error } = await supabase
      .from("exam_scan_pages")
      .select("ocr_text, ocr_data")
      .eq("id", pageId)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  async function end(r: Pick<Race, "a" | "lock" | "tag">) {
    await r.lock.query("ROLLBACK").catch(() => {});
    await cleanupTag(r.a, r.tag).catch(() => {});
    await r.a.end().catch(() => {});
    await r.lock.end().catch(() => {});
  }

  /** While B is held at its write: A's attempt was refused, and B's message is untouched. */
  async function expectOnlyBHolds(r: Race) {
    const state = await tagged(r.a, r.tag);
    expect(state.queued.map((m) => [Number(m.msg_id), m.read_ct])).toEqual([[r.msgId, 2]]);
    expect(state.archived).toEqual([]);
  }

  /** After B: exactly B's message archived, nothing else ever queued, nothing dead-lettered. */
  async function expectBFinishedAlone(r: Race) {
    expect(await tagged(r.a, r.tag)).toEqual({ queued: [], archived: [r.msgId] });
    expect(await dlqRecords(r.a, r.tag)).toEqual({ queue: 0, audit: [] });
    expect(await batchRow(r.batchId)).toEqual({ status: "ocr", error: null });
  }

  test("A finished and acks: refused; its OCR stays, B's late result is dropped, B acks", async () => {
    const r = await raceToOcrWrite("expired holder finished");
    try {
      // A's success: its OCR write lands first (inside the lock's transaction), then its ack.
      await r.lock.query(
        "UPDATE public.exam_scan_pages SET ocr_text = 'first result', ocr_data = $2::jsonb WHERE id = $1",
        [r.pageId, JSON.stringify({ words: [{ text: "first", x: 0.1, y: 0.1, width: 0.1, height: 0.02 }] })]
      );
      expect(await callFn("exam_worker_ack", ackArgs({ msgId: r.msgId, readCt: 1 }))).toBe("not_owner");
      await expectOnlyBHolds(r);
      await releaseAndWaitForB(r);
      // B's write found OCR already there and matched no row.
      expect((await pageOcr(r.pageId)).ocr_text).toBe("first result");
      await expectBFinishedAlone(r);
    } finally {
      await end(r);
    }
  });

  test("A failed and re-queues: refused, so no replacement exists, and the page's OCR is B's", async () => {
    const r = await raceToOcrWrite("expired holder retried");
    try {
      expect(
        await callFn(
          "exam_worker_requeue",
          requeueArgs({ msgId: r.msgId, readCt: 1 }, { ...r.envelope, retry_count: 1 }, 0, false)
        )
      ).toBe("not_owner");
      await expectOnlyBHolds(r);
      await releaseAndWaitForB(r);
      // No other message for this page ever existed, so the OCR stored now can only be B's write.
      const ocr = await pageOcr(r.pageId);
      expect(ocr.ocr_data).not.toBeNull();
      expect(ocr.ocr_text).not.toBe("first result");
      await expectBFinishedAlone(r);
    } finally {
      await end(r);
    }
  });

  test("A gave up: refused, so the batch is not errored, nothing is dead-lettered, and B finishes", async () => {
    const r = await raceToOcrWrite("expired holder gave up");
    try {
      expect(
        await callFn(
          "exam_worker_give_up",
          giveUpArgs(
            { msgId: r.msgId, readCt: 1 },
            { batchId: r.batchId, from: ["ocr"], error: "A gave up", errorType: "Error", envelope: r.envelope }
          )
        )
      ).toBe("not_owner");
      await expectOnlyBHolds(r);
      await releaseAndWaitForB(r);
      expect((await pageOcr(r.pageId)).ocr_data).not.toBeNull();
      await expectBFinishedAlone(r);
    } finally {
      await end(r);
    }
  });
});
