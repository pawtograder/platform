/**
 * #1329: Process must not queue a batch again while it is already being processed.
 *
 * enqueue_exam_process_batch sends one OCR job per page plus a match job. Before the guard
 * (20261120140000_exam_process_batch_status_guard.sql), a second call while the batch was still in
 * ocr or matching sent the whole round again, and every extra OCR job is a paid Vision call. It now
 * locks the batch row and refuses ocr, matching, finalizing and completed.
 *
 * The RPC also wakes the worker, which can move the batch along between two calls. So the accepted
 * cases run as the grader in a transaction that is rolled back (the worker never sees them), and the
 * concurrent case holds the first call's transaction open while the second waits on its lock.
 *
 * Needs the disposable-database variables courseGeminiKeyDb.ts checks (CI's e2e-local sets them).
 */
import { expect, test } from "@playwright/test";
import type { Client } from "pg";
import { addDays } from "date-fns";
import { backendPid, beginAsUser, privilegedClient, waitUntilBlocked } from "./courseGeminiKeyDb";
import { createAuthenticatedClient, createClass, createUserInClass, insertAssignment, supabase } from "./TestingUtils";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const PAGES = 2; // two one-page exams, so one round is 2 OCR jobs + 1 match job
const ONE_ROUND = PAGES + 1;
const BUSY = /already being processed/;

type BatchStatus = "uploaded" | "ocr" | "matching" | "review" | "finalizing" | "completed" | "error";

/** A grader and a batch with every page stored, in `status`. */
async function seedBatch(status: BatchStatus) {
  const course = await createClass({ name: "Process guard" });
  const grader = await createUserInClass({ role: "grader", class_id: course.id });
  const assignment = await insertAssignment({
    class_id: course.id,
    name: "Process guard exam",
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
    .insert({ class_id: course.id, exam_id: examId as number, total_pages: PAGES, pages_per_exam: 1, status })
    .select("id")
    .single();
  expect(error).toBeNull();
  for (let i = 0; i < PAGES; i++) {
    const path = `classes/${course.id}/exams/${examId}/batches/${batch!.id}/page-${i}.png`;
    const up = await supabase.storage.from("exam-scans").upload(path, PNG_1x1, { contentType: "image/png" });
    expect(up.error).toBeNull();
    const { error: pageErr } = await supabase.from("exam_scan_pages").insert({
      class_id: course.id,
      exam_id: examId as number,
      batch_id: batch!.id,
      page_index: i,
      image_path: path,
      width: 1000,
      height: 1400
    });
    expect(pageErr).toBeNull();
  }
  return { grader, batchId: batch!.id };
}

/** Messages enqueue_exam_process_batch sent for the batch, queued or already archived by the worker. */
async function sentFor(client: Client, batchId: number): Promise<number> {
  // The worker's retries and OCR waits are fresh messages carrying retry_count or ocr_waits; only
  // the RPC's own sends lack both.
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT message FROM pgmq.q_exam_processing UNION ALL SELECT message FROM pgmq.a_exam_processing
     ) m
     WHERE m.message->>'batch_id' = $1::text
       AND NOT m.message ? 'retry_count' AND NOT m.message ? 'ocr_waits'`,
    [batchId]
  );
  return rows[0].n;
}

async function statusIn(client: Client, batchId: number): Promise<string> {
  const { rows } = await client.query<{ status: string }>("SELECT status FROM public.exam_scan_batches WHERE id = $1", [
    batchId
  ]);
  return rows[0].status;
}

const processAs = (client: Client, batchId: number) =>
  client.query<{ n: number }>("SELECT public.enqueue_exam_process_batch($1) AS n", [batchId]);

test.describe("Process is refused while the batch is already being processed (#1329)", () => {
  for (const status of ["ocr", "matching", "finalizing", "completed"] as const) {
    test(`a batch in ${status} is refused and nothing is queued`, async () => {
      const { grader, batchId } = await seedBatch(status);
      const staff = await createAuthenticatedClient(grader);
      const client = await privilegedClient();
      try {
        const { error } = await staff.rpc("enqueue_exam_process_batch", { p_batch_id: batchId });
        expect(error?.code).toBe("P0001");
        expect(error?.message).toMatch(status === "completed" ? /is completed/ : BUSY);
        expect(await statusIn(client, batchId)).toBe(status);
        expect(await sentFor(client, batchId)).toBe(0);
      } finally {
        await client.end();
      }
    });
  }

  for (const status of ["uploaded", "review", "error"] as const) {
    test(`a batch in ${status} is accepted and queued once`, async () => {
      const { grader, batchId } = await seedBatch(status);
      const client = await privilegedClient();
      try {
        await beginAsUser(client, grader.user_id);
        const { rows } = await processAs(client, batchId);
        expect(rows[0].n).toBe(PAGES);
        await client.query("RESET ROLE");
        expect(await statusIn(client, batchId)).toBe("ocr");
        expect(await sentFor(client, batchId)).toBe(ONE_ROUND);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        await client.end();
      }
    });
  }

  test("a second Process right after the first is refused and queues nothing more", async () => {
    const { grader, batchId } = await seedBatch("uploaded");
    const client = await privilegedClient();
    try {
      await beginAsUser(client, grader.user_id);
      await processAs(client, batchId);
      await client.query("SAVEPOINT second");
      const second = await processAs(client, batchId).then(
        () => "queued",
        (e: Error) => e.message
      );
      expect(second).toMatch(BUSY);
      await client.query("ROLLBACK TO SAVEPOINT second");
      await client.query("RESET ROLE");
      expect(await sentFor(client, batchId)).toBe(ONE_ROUND);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  });

  test("two Process calls at once: the second waits for the first, then is refused", async () => {
    const { grader, batchId } = await seedBatch("uploaded");
    const first = await privilegedClient();
    const second = await privilegedClient();
    const monitor = await privilegedClient();
    try {
      // Backend pids first: a connection runs one query at a time, so asking a blocked one is a hang.
      const [firstPid, secondPid] = [await backendPid(first), await backendPid(second)];
      await beginAsUser(first, grader.user_id);
      await processAs(first, batchId);
      await beginAsUser(second, grader.user_id);
      const pending = processAs(second, batchId).then(
        () => "queued",
        (e: Error) => e.message
      );
      const blocked = await waitUntilBlocked(monitor, secondPid, firstPid, 5000);
      expect(blocked.observed).toBe(true);
      await first.query("COMMIT");
      expect(await pending).toMatch(BUSY);
      await second.query("ROLLBACK");
      expect(await sentFor(monitor, batchId)).toBe(ONE_ROUND);
    } finally {
      await Promise.all([first.end(), second.end(), monitor.end()]);
    }
  });
});
