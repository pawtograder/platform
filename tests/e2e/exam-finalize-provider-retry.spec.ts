import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import { createClass, createUserInClass, insertAssignment, supabase } from "./TestingUtils";

/**
 * #1077: a temporary provider failure while finalize structures an answer must be retried, not
 * finalized with the raw OCR text.
 *
 * The per-PR stack serves the worker with EXAM_VISION_PROVIDER=fake, whose structureAnswer throws
 * ProviderTransientError for a page whose name contains "__fault-transient__". How the Gemini
 * adapter classifies 5xx, timeouts and resets is covered by _shared/examVision.provider.test.ts.
 */

const FUNCTIONS_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const EDGE_SECRET = process.env.EDGE_FUNCTION_SECRET ?? "some-secret-value";
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const ANSWER_REGION = { x: 0.1, y: 0.3, width: 0.8, height: 0.2 };

async function runExamWorker(): Promise<void> {
  await fetch(`${FUNCTIONS_URL}/functions/v1/exam-async-worker`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-edge-function-secret": EDGE_SECRET },
    body: "{}"
  }).catch(() => {
    // best-effort; the test polls the DB for the result
  });
}

/** A finalizing batch with two confirmed one-page exams; only the faulty one's page carries the marker. */
async function arrange() {
  const course = await createClass({ name: "Exam finalize provider retry E2E" });
  const assignment = await insertAssignment({
    class_id: course.id,
    name: "Numeric Exam",
    assignment_type: "exam",
    due_date: addDays(new Date(), 7).toISOString()
  });
  const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
    p_assignment_id: assignment.id,
    p_source_type: "pdf",
    p_num_pages: 1
  });
  expect(examErr).toBeNull();
  const { error: structErr } = await supabase.rpc("exam_upsert_questions_and_regions", {
    p_exam_id: examId as number,
    p_questions: [
      { client_id: "q1", parent_client_id: null, level: 1, ordinal: 0, label: "Q1" },
      {
        client_id: "c1",
        parent_client_id: "q1",
        level: 2,
        ordinal: 0,
        label: "Item 1",
        answer_type: "numeric",
        points: 5
      }
    ],
    p_regions: [{ question_client_id: "c1", kind: "answer", page_number: 1, ...ANSWER_REGION }]
  });
  expect(structErr).toBeNull();
  const { data: batch, error: batchErr } = await supabase
    .from("exam_scan_batches")
    .insert({ class_id: course.id, exam_id: examId as number, total_pages: 2, pages_per_exam: 1, status: "review" })
    .select("id")
    .single();
  expect(batchErr).toBeNull();

  const rowIds: number[] = [];
  for (const [i, file] of ["page-0.png", "page-1__fault-transient__.png"].entries()) {
    const student = await createUserInClass({ role: "student", class_id: course.id });
    const path = `classes/${course.id}/exams/${examId}/batches/${batch!.id}/${file}`;
    const up = await supabase.storage.from("exam-scans").upload(path, PNG_1x1, { contentType: "image/png" });
    expect(up.error).toBeNull();
    const { data: row, error: rowErr } = await supabase
      .from("exam_scanned_submissions")
      .insert({
        class_id: course.id,
        exam_id: examId as number,
        batch_id: batch!.id,
        exam_index: i,
        matched_profile_id: student.private_profile_id,
        match_confidence: 1,
        match_status: "confirmed"
      })
      .select("id")
      .single();
    expect(rowErr).toBeNull();
    // Stored OCR with one word inside the numeric answer region, so structuring is the only
    // provider call finalize makes.
    const { error: pageErr } = await supabase.from("exam_scan_pages").insert({
      class_id: course.id,
      exam_id: examId as number,
      batch_id: batch!.id,
      page_index: i,
      image_path: path,
      width: 1000,
      height: 1400,
      ocr_text: "42",
      ocr_data: { words: [{ text: "42", x: 0.4, y: 0.35, width: 0.1, height: 0.05 }] },
      scanned_submission_id: row!.id
    });
    expect(pageErr).toBeNull();
    rowIds.push(row!.id);
  }
  return { classId: course.id, batchId: batch!.id, controlId: rowIds[0], faultyId: rowIds[1] };
}

async function row(id: number) {
  const { data } = await supabase
    .from("exam_scanned_submissions")
    .select("finalized_at, submission_id")
    .eq("id", id)
    .single();
  const submissionId = data?.submission_id ?? null;
  if (submissionId === null) return { finalized: data?.finalized_at != null, files: 0, examArtifacts: 0 };
  const { count: files } = await supabase
    .from("submission_files")
    .select("id", { count: "exact", head: true })
    .eq("submission_id", submissionId);
  const { count: examArtifacts } = await supabase
    .from("submission_artifacts")
    .select("id", { count: "exact", head: true })
    .eq("submission_id", submissionId)
    .eq("data->>format", "exam_v1");
  return { finalized: data?.finalized_at != null, files: files ?? 0, examArtifacts: examArtifacts ?? 0 };
}

async function batchState(fx: { batchId: number; classId: number }) {
  const { data: batch } = await supabase
    .from("exam_scan_batches")
    .select("status, error")
    .eq("id", fx.batchId)
    .single();
  const { count: dlq } = await supabase
    .from("exam_async_worker_dlq_messages")
    .select("id", { count: "exact", head: true })
    .eq("class_id", fx.classId);
  return { status: batch?.status, error: batch?.error ?? null, dlq: dlq ?? 0 };
}

test("a transient provider failure while structuring is retried, not finalized with raw OCR text (#1077)", async () => {
  test.setTimeout(180_000);
  const fx = await arrange();
  const { data: queued, error } = await supabase.rpc("enqueue_exam_finalize", { p_batch_id: fx.batchId });
  expect(error).toBeNull();
  expect(queued).toBe(2);
  let cleanedUp = false;
  try {
    // Both exams' first attempts have run: the control finished, and the faulty one got as far
    // as its page file, which finalize writes just before structuring the answer.
    await expect
      .poll(
        async () => {
          await runExamWorker();
          const [control, faulty] = await Promise.all([row(fx.controlId), row(fx.faultyId)]);
          return control.finalized && faulty.files === 1;
        },
        { timeout: 90_000, intervals: [1000, 2000] }
      )
      .toBe(true);
    // A worker that swallowed the failure finishes the same attempt within milliseconds of the
    // file insert; the first retry is not due for 10s.
    await new Promise((r) => setTimeout(r, 3000));

    expect(await row(fx.controlId)).toEqual({ finalized: true, files: 1, examArtifacts: 1 });
    expect(await row(fx.faultyId), "the faulty exam was finalized from the raw OCR text").toEqual({
      finalized: false,
      files: 1,
      examArtifacts: 0
    });
    // Requeued for a retry, not dead-lettered.
    expect(await batchState(fx)).toEqual({ status: "finalizing", error: null, dlq: 0 });

    // Stand in for the provider recovering: with finalized_at set, the retry is finalize's
    // idempotent no-op, and that no-op is what completes the batch, since nothing else enqueues
    // work for it. So completion proves a retry was scheduled. It must arrive well inside the
    // 120s visibility timeout that would redeliver a message that was neither archived nor
    // requeued: the first retry is due 10s after the failure.
    const { error: stampErr } = await supabase
      .from("exam_scanned_submissions")
      .update({ finalized_at: new Date().toISOString() })
      .eq("id", fx.faultyId);
    expect(stampErr).toBeNull();
    cleanedUp = true;
    await expect
      .poll(
        async () => {
          await runExamWorker();
          return (await batchState(fx)).status;
        },
        { timeout: 60_000, intervals: [2000] }
      )
      .toBe("completed");
    expect(await batchState(fx)).toEqual({ status: "completed", error: null, dlq: 0 });
  } finally {
    // Never leave the faulty exam failing on every retry (and dead-lettering minutes later) in the
    // shared stack: once it is stamped, its remaining message is a no-op.
    if (!cleanedUp) {
      await supabase
        .from("exam_scanned_submissions")
        .update({ finalized_at: new Date().toISOString() })
        .eq("id", fx.faultyId);
    }
  }
});
