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
import { createClass, createUserInClass, insertAssignment, supabase } from "./TestingUtils";

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
          "AND (message->'args'->>'scanned_submission_id')::bigint = $1",
        [aliceRow.id]
      );
      expect(again).toHaveLength(0);
      const { rows: dead } = await client.query(
        "SELECT id FROM public.exam_async_worker_dlq_messages WHERE (envelope->'args'->>'scanned_submission_id')::bigint = $1",
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

/**
 * A reader whose lease lapsed keeps running, and archives by msg_id, so it can archive the message a
 * newer reader now holds (#1158; CodeRabbit and Jon on #1308). These run the three ways an expired
 * holder A ends a process_page message while the real worker B holds it, and check that no
 * unfinished work is lost.
 *
 * Interleaving: A claims the message and lets its lease lapse; a row lock on the page makes B, once
 * it has claimed the message, read the page and called the provider, wait at its OCR write; A then
 * acts inside the lock's transaction and commits, and B carries on. Needs exam-async-worker running
 * (CI's e2e-local serves it) with the fake vision provider.
 */
test.describe("an expired holder that archives the newer holder's message loses no work (#1158)", () => {
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

  /** Set up the race up to the point where B waits at its OCR write and A is free to act. */
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
    const course = { id: classId };
    const tag = randomUUID();
    const envelope = {
      method: "process_page",
      class_id: course.id,
      batch_id: batchId,
      args: { scan_page_id: page!.id },
      test_tag: tag
    };
    const a = await privilegedClient();
    const lock = await privilegedClient();
    // A sends and claims in one transaction, so no running worker sees the message unclaimed.
    await a.query("BEGIN");
    const sent = await a.query<{ id: string }>("SELECT pgmq.send('exam_processing', $1::jsonb) AS id", [
      JSON.stringify(envelope)
    ]);
    const claimA = await claimAs(a, tag);
    await a.query("COMMIT");
    const msgId = Number(sent.rows[0].id);
    expect(claimA).toEqual({ msgId, readCt: 1, tag });
    const base: Base = { a, tag, msgId, pageId: page!.id, batchId, classId: course.id, envelope };
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
  }

  /** A commits; then wait until B's OCR write has finished (its connection no longer waits on a lock). */
  async function releaseAndWaitForB(r: Race) {
    await r.lock.query("COMMIT");
    await expect
      .poll(
        async () =>
          (
            await r.a.query<{ waiting: boolean }>(
              "SELECT coalesce(bool_or(wait_event_type = 'Lock'), false) AS waiting FROM pg_stat_activity WHERE pid = $1",
              [r.workerPid]
            )
          ).rows[0].waiting,
        { timeout: 10_000 }
      )
      .toBe(false);
    // B's handler then archives (a no-op) and releases its lease; give it a moment to finish.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  async function pageOcr(pageId: number) {
    const { data } = await supabase.from("exam_scan_pages").select("ocr_text, ocr_data").eq("id", pageId).single();
    return data;
  }

  async function queued(r: Base) {
    return (await r.a.query("SELECT msg_id FROM pgmq.q_exam_processing WHERE message->>'test_tag' = $1", [r.tag])).rows;
  }

  async function deadLettered(r: Base) {
    return (
      await r.a.query("SELECT id FROM public.exam_async_worker_dlq_messages WHERE envelope->>'test_tag' = $1", [r.tag])
    ).rows;
  }

  async function end(r: Race) {
    await r.lock.query("ROLLBACK").catch(() => {});
    await r.a.query(
      "SELECT pgmq.archive('exam_processing', msg_id) FROM pgmq.q_exam_processing WHERE message->>'test_tag' = $1",
      [r.tag]
    );
    await r.a.end();
    await r.lock.end();
  }

  test("A finished: its OCR stays, B's late result is dropped, nothing is redone or dead-lettered", async () => {
    const r = await raceToOcrWrite("expired holder finished");
    try {
      // A's success path: write OCR, then archive the message by msg_id, so B's claim on it too.
      await r.lock.query(
        "UPDATE public.exam_scan_pages SET ocr_text = 'first result', ocr_data = $2::jsonb WHERE id = $1",
        [r.pageId, JSON.stringify({ words: [{ text: "first", x: 0.1, y: 0.1, width: 0.1, height: 0.02 }] })]
      );
      await r.lock.query("SELECT pgmq.archive('exam_processing', $1::bigint)", [r.msgId]);
      await releaseAndWaitForB(r);
      // B's write found OCR already there and matched no row: the stored OCR is still A's.
      expect((await pageOcr(r.pageId))?.ocr_text).toBe("first result");
      const { rows: archived } = await r.a.query("SELECT msg_id FROM pgmq.a_exam_processing WHERE msg_id = $1", [
        r.msgId
      ]);
      expect(archived).toHaveLength(1);
      expect(await queued(r)).toHaveLength(0);
      expect(await deadLettered(r)).toHaveLength(0);
      expect(await batchRow(r.batchId)).toEqual({ status: "ocr", error: null });
    } finally {
      await end(r);
    }
  });

  test("A failed and re-queued: B's OCR is kept, and the replacement finds the page done", async () => {
    const r = await raceToOcrWrite("expired holder retried");
    try {
      // A's transient-error path: send the replacement first, then archive the message by msg_id.
      await r.lock.query("SELECT pgmq.send('exam_processing', $1::jsonb)", [
        JSON.stringify({ ...r.envelope, retry_count: 1 })
      ]);
      await r.lock.query("SELECT pgmq.archive('exam_processing', $1::bigint)", [r.msgId]);
      await releaseAndWaitForB(r);
      // B's OCR is the page's (the fake provider reads the object path, not 'first result').
      const afterB = await pageOcr(r.pageId);
      expect(afterB?.ocr_data).not.toBeNull();
      // The replacement runs, finds OCR there, and is archived: at worst a duplicate run.
      await expect
        .poll(
          async () => {
            await runExamWorker();
            return (await queued(r)).length;
          },
          { timeout: 60_000, intervals: [1000, 2000, 3000] }
        )
        .toBe(0);
      const { rows: replacement } = await r.a.query(
        "SELECT msg_id FROM pgmq.a_exam_processing WHERE message->>'test_tag' = $1 AND msg_id <> $2",
        [r.tag, r.msgId]
      );
      expect(replacement).toHaveLength(1);
      expect(await pageOcr(r.pageId)).toEqual(afterB);
      expect(await deadLettered(r)).toHaveLength(0);
      expect(await batchRow(r.batchId)).toEqual({ status: "ocr", error: null });
    } finally {
      await end(r);
    }
  });

  test("A gave up: the batch keeps A's error and one DLQ record, and B cannot undo it", async () => {
    const r = await raceToOcrWrite("expired holder gave up", async (base) => {
      // A's give-up while it still held the message: the fenced error write applies.
      expect(
        await setStatus(base.a, { msgId: base.msgId, readCt: 1 }, base.batchId, "error", ["ocr"], "A gave up")
      ).toBe("applied");
    });
    try {
      // After its lease lapsed and B claimed: dead-letter, then archive by msg_id.
      await r.lock.query(
        "INSERT INTO public.exam_async_worker_dlq_messages " +
          "(original_msg_id, method, envelope, error_message, error_type, class_id) " +
          "VALUES ($1, 'process_page', $2::jsonb, 'A gave up', 'Error', $3)",
        [r.msgId, JSON.stringify(r.envelope), r.classId]
      );
      await r.lock.query("SELECT pgmq.archive('exam_processing', $1::bigint)", [r.msgId]);
      await releaseAndWaitForB(r);
      // The failure stays visible (Retry recovers it), B's work did not move the batch, and with
      // its message gone B's own status writes are refused.
      expect(await batchRow(r.batchId)).toEqual({ status: "error", error: "A gave up" });
      expect(await deadLettered(r)).toHaveLength(1);
      expect(await queued(r)).toHaveLength(0);
      expect(await setStatus(r.a, { msgId: r.msgId, readCt: 2 }, r.batchId, "ocr", ["error"])).toBe("not_owner");
      expect(await batchRow(r.batchId)).toEqual({ status: "error", error: "A gave up" });
    } finally {
      await end(r);
    }
  });
});
