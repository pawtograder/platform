/**
 * #1158: exam_worker_set_batch_status changes a batch's status only while the calling worker still
 * holds its queue message, and only from the states the caller allows, in one transaction
 * (20261116140000_pgmq_public_set_vt_if_claimed.sql).
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
import { backendPid, privilegedClient, waitUntilBlocked } from "./courseGeminiKeyDb";
import { createClass, insertAssignment, supabase } from "./TestingUtils";

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
