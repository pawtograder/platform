/**
 * #1158: exam_worker_set_batch_status changes a batch's status only while the calling worker still
 * holds its queue message, and only from the states the caller allows, in one transaction
 * (20261120170000_pgmq_public_set_vt_if_claimed.sql).
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
import { createClass, createUserInClass, insertAssignment, supabase } from "./TestingUtils";

type Claim = { msgId: number; readCt: number; tag: string };

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
  return { classId: course.id, batchId: batch!.id };
}

/**
 * Queue a message for the batch and claim it the way the worker does (pgmq.read), as "our" worker.
 * scanned_submission_id -1: if a running worker ever picked it up, finalize would only fail to find
 * the row, before touching any batch.
 */
async function queueAndClaim(client: Client, classId: number, batchId: number): Promise<Claim> {
  const tag = randomUUID();
  const message = {
    method: "finalize",
    class_id: classId,
    batch_id: batchId,
    args: { scanned_submission_id: -1 },
    test_tag: tag
  };
  // Sent and claimed in one transaction, so a running worker never sees it unclaimed.
  await client.query("BEGIN");
  const sent = await client.query<{ id: string }>("SELECT pgmq.send('exam_processing', $1::jsonb) AS id", [
    JSON.stringify(message)
  ]);
  const claim = await claimAs(client, tag);
  await client.query("COMMIT");
  expect(claim?.msgId).toBe(Number(sent.rows[0].id));
  return claim!;
}

/** pgmq.read restricted to this test's message. Returns null when nothing was claimable. */
async function claimAs(client: Client, tag: string): Promise<Claim | null> {
  const { rows } = await client.query<{ msg_id: string; read_ct: number }>(
    "SELECT msg_id, read_ct FROM pgmq.read('exam_processing', 30, 1, $1::jsonb)",
    [JSON.stringify({ test_tag: tag })]
  );
  return rows.length ? { msgId: Number(rows[0].msg_id), readCt: rows[0].read_ct, tag } : null;
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
  const { data } = await supabase.from("exam_scan_batches").select("status, error").eq("id", batchId).single();
  return data;
}

async function cleanup(client: Client, msgId: number) {
  await client.query("SELECT pgmq.archive('exam_processing', $1::bigint)", [msgId]);
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
      const pending = setStatus(writer, ours, batchId, "error", ["finalizing"], "from the former holder");
      expect((await waitUntilBlocked(monitor, writerPid, readerPid, 5000)).observed).toBe(true);
      await reader.query("COMMIT");
      expect(await pending).toBe("not_owner");
      expect(await batchRow(batchId)).toEqual({ status: "finalizing", error: null });
      await cleanup(writer, ours.msgId);
    } finally {
      await writer.end();
      await reader.end();
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
    await supabase
      .from("exam_scanned_submissions")
      .update({ finalized_at: new Date().toISOString() })
      .eq("id", aliceRow.id);

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
