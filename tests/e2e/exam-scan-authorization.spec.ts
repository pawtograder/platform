import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "date-fns";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertAssignment,
  setUserSisId,
  supabase,
  type TestingUser
} from "./TestingUtils";

/**
 * #1078: a grader must not be able to make the exam worker read or copy a scan from another
 * course (or another exam or batch of their own course) by pointing exam_scan_pages.image_path at
 * it. Every attempted write, upload, download and enqueue here runs as an ordinary signed-in user
 * against real RLS and storage; the service-role client only arranges course B and inspects
 * outcomes.
 *
 * What proves a read happened: the `fake` vision provider builds its OCR text from the object
 * path it was handed, after the worker downloaded it (processPage downloads before it calls the
 * provider). So course B's path showing up in course A's OCR means B's object was read. For the
 * copy step, the proof is a submission file in course A whose bytes hash to B's object.
 *
 * Everything in the first describe runs before finalize's answer-region query, so it does not
 * depend on #1075. The last describe (the full successful finalization) does.
 */

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const FUNCTIONS_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const EDGE_SECRET = process.env.EDGE_FUNCTION_SECRET ?? "some-secret-value";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Kick the exam worker (drains the queue) the way the cron/RPC would. */
async function runExamWorker(): Promise<void> {
  await fetch(`${FUNCTIONS_URL}/functions/v1/exam-async-worker`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-edge-function-secret": EDGE_SECRET },
    body: "{}"
  }).catch(() => {
    // best-effort; the test polls the DB for the result
  });
}

/** An exam with identity and free-text answer regions, as the instructor UI would create it. */
async function createExam(classId: number, name: string): Promise<number> {
  const assignment = await insertAssignment({
    class_id: classId,
    name,
    assignment_type: "exam",
    due_date: addDays(new Date(), 7).toISOString()
  });
  const { data: examId, error } = await supabase.rpc("exam_create", {
    p_assignment_id: assignment.id,
    p_source_type: "pdf",
    p_num_pages: 1
  });
  expect(error).toBeNull();
  const { error: structErr } = await supabase.rpc("exam_upsert_questions_and_regions", {
    p_exam_id: examId as number,
    p_questions: [
      { client_id: "p1", parent_client_id: null, level: 1, ordinal: 0, label: "Part A" },
      { client_id: "q1", parent_client_id: "p1", level: 2, ordinal: 0, label: "Q1" },
      { client_id: "c1", parent_client_id: "q1", level: 3, ordinal: 0, answer_type: "free_text", points: 5 }
    ],
    p_regions: [
      { question_client_id: "c1", kind: "answer", page_number: 1, x: 0.1, y: 0.3, width: 0.8, height: 0.2 },
      { question_client_id: null, kind: "student_id", page_number: 1, x: 0.1, y: 0.05, width: 0.5, height: 0.06 },
      { question_client_id: null, kind: "name", page_number: 1, x: 0.1, y: 0.12, width: 0.5, height: 0.06 }
    ]
  });
  expect(structErr).toBeNull();
  return examId as number;
}

type CourseA = {
  classId: number;
  examId: number;
  otherExamId: number;
  grader: SupabaseClient<Database>;
  student: TestingUser;
  studentClient: SupabaseClient<Database>;
  studentSis: number;
};
type CourseB = { classId: number; batchId: number; objectPath: string; objectSha: string };

/** Course A: an exam, a second exam, a grader who belongs only to A, and a student. */
async function arrangeCourseA(): Promise<CourseA> {
  const course = await createClass({ name: "Scan auth A" });
  const examId = await createExam(course.id, "Midterm");
  const otherExamId = await createExam(course.id, "Final");
  const graderUser = await createUserInClass({ role: "grader", class_id: course.id });
  const student = await createUserInClass({ role: "student", class_id: course.id, name: "Alice Smith" });
  const studentSis = 300000 + ((course.id * 10) % 2_000_000_000) + 1;
  await setUserSisId(student.user_id, studentSis);
  return {
    classId: course.id,
    examId,
    otherExamId,
    grader: await createAuthenticatedClient(graderUser),
    student,
    studentClient: await createAuthenticatedClient(student),
    studentSis
  };
}

/** Course B: an instructor uploads a scan into B's exam-scans folder through their own session. */
async function arrangeCourseB(): Promise<CourseB> {
  const course = await createClass({ name: "Scan auth B" });
  const examId = await createExam(course.id, "B Midterm");
  const { data: batch } = await supabase
    .from("exam_scan_batches")
    .insert({ class_id: course.id, exam_id: examId, total_pages: 1, pages_per_exam: 1, status: "uploaded" })
    .select("id")
    .single();
  const instructor = await createAuthenticatedClient(
    await createUserInClass({ role: "instructor", class_id: course.id })
  );
  const objectPath = `classes/${course.id}/exams/${examId}/batches/${batch!.id}/sis-777__name-Course_B_Student__page-0.png`;
  const bytes = Buffer.concat([PNG_1x1, Buffer.from(`course-B-scan-${randomUUID()}`)]);
  const up = await instructor.storage
    .from("exam-scans")
    .upload(objectPath, bytes, { contentType: "image/png", upsert: true });
  expect(up.error).toBeNull();
  return { classId: course.id, batchId: batch!.id, objectPath, objectSha: sha256(bytes) };
}

/** As the grader: create a one-page batch and its page row, uploading our own page image first. */
async function graderCreatesBatch(a: CourseA, opts: { examId?: number; imagePath?: (batchId: number) => string }) {
  const examId = opts.examId ?? a.examId;
  const { data: batch, error: batchErr } = await a.grader
    .from("exam_scan_batches")
    .insert({ class_id: a.classId, exam_id: examId, total_pages: 1, pages_per_exam: 1, status: "uploaded" })
    .select("id")
    .single();
  expect(batchErr).toBeNull();
  const ownPath = `classes/${a.classId}/exams/${examId}/batches/${batch!.id}/sis-${a.studentSis}__name-Alice_Smith__page-0.png`;
  const ownBytes = Buffer.concat([PNG_1x1, Buffer.from(`course-A-scan-${randomUUID()}`)]);
  const up = await a.grader.storage.from("exam-scans").upload(ownPath, ownBytes, { contentType: "image/png" });
  expect(up.error).toBeNull();
  const { data: page, error: pageErr } = await a.grader
    .from("exam_scan_pages")
    .insert({
      class_id: a.classId,
      exam_id: examId,
      batch_id: batch!.id,
      page_index: 0,
      image_path: opts.imagePath ? opts.imagePath(batch!.id) : ownPath,
      width: 1000,
      height: 1400
    })
    .select("id")
    .single();
  // The write itself is not where #1078 is enforced: row RLS allows it, the worker refuses it.
  expect(pageErr).toBeNull();
  return { batchId: batch!.id, pageId: page!.id, ownPath, ownSha: sha256(ownBytes) };
}

async function batch(batchId: number) {
  const { data } = await supabase.from("exam_scan_batches").select("status, error").eq("id", batchId).single();
  return data!;
}

/** Process as the grader and wait until the worker has either reached review or errored. */
async function graderProcesses(a: CourseA, batchId: number) {
  const { error } = await a.grader.rpc("enqueue_exam_process_batch", { p_batch_id: batchId });
  expect(error).toBeNull();
  await expect
    .poll(
      async () => {
        await runExamWorker();
        return (await batch(batchId)).status;
      },
      { timeout: 60_000, intervals: [1000, 2000, 3000] }
    )
    .toMatch(/^(review|error)$/);
  return batch(batchId);
}

async function expectRejectedWithoutReading(a: CourseA, b: CourseB | null, batchId: number, pageId: number) {
  const state = await batch(batchId);
  expect(state.status).toBe("error");
  expect(state.error ?? "").toMatch(/refusing to read it/);
  const { data: page } = await supabase.from("exam_scan_pages").select("ocr_text, ocr_data").eq("id", pageId).single();
  expect(page?.ocr_text ?? null).toBeNull();
  expect(page?.ocr_data ?? null).toBeNull();
  if (b) {
    const { count } = await supabase
      .from("exam_scan_pages")
      .select("id", { count: "exact", head: true })
      .eq("class_id", a.classId)
      .ilike("ocr_text", `%classes/${b.classId}/%`);
    expect(count).toBe(0);
  }
  const { data: dlq } = await supabase
    .from("exam_async_worker_dlq_messages")
    .select("error_type")
    .eq("class_id", a.classId)
    .eq("envelope->>batch_id", String(batchId));
  expect((dlq ?? []).map((d) => d.error_type)).toContain("ScanPathRejectedError");
}

/** Bytes of every course-A submission file, as stored and as the grader and student can fetch them. */
async function courseASubmissionFileHashes(a: CourseA) {
  const { data: files } = await supabase.from("submission_files").select("storage_key").eq("class_id", a.classId);
  const stored: string[] = [];
  const graderCanFetch: string[] = [];
  const studentCanFetch: string[] = [];
  for (const f of files ?? []) {
    if (!f.storage_key) continue;
    const adminDl = await supabase.storage.from("submission-files").download(f.storage_key);
    if (adminDl.data) stored.push(sha256(new Uint8Array(await adminDl.data.arrayBuffer())));
    const g = await a.grader.storage.from("submission-files").download(f.storage_key);
    if (g.data) graderCanFetch.push(sha256(new Uint8Array(await g.data.arrayBuffer())));
    const s = await a.studentClient.storage.from("submission-files").download(f.storage_key);
    if (s.data) studentCanFetch.push(sha256(new Uint8Array(await s.data.arrayBuffer())));
  }
  return { count: (files ?? []).length, stored, graderCanFetch, studentCanFetch };
}

test.describe("Exam scan ownership (#1078)", () => {
  let a: CourseA;
  let b: CourseB;
  test.beforeAll(async () => {
    a = await arrangeCourseA();
    b = await arrangeCourseB();
  });

  test("the course-A grader cannot download course B's scan directly", async () => {
    const { data, error } = await a.grader.storage.from("exam-scans").download(b.objectPath);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  test("inserting a page that points at course B's scan is rejected before the worker reads it", async () => {
    const { batchId, pageId } = await graderCreatesBatch(a, { imagePath: () => b.objectPath });
    await graderProcesses(a, batchId);
    await expectRejectedWithoutReading(a, b, batchId, pageId);
  });

  test("updating a page to point at course B's scan is rejected before the worker reads it", async () => {
    const { batchId, pageId } = await graderCreatesBatch(a, {});
    const { error } = await a.grader.from("exam_scan_pages").update({ image_path: b.objectPath }).eq("id", pageId);
    expect(error).toBeNull();
    await graderProcesses(a, batchId);
    await expectRejectedWithoutReading(a, b, batchId, pageId);
  });

  test("a path in the same course but another exam or another batch is rejected", async () => {
    // Real objects the grader may legitimately upload: same class, but not this batch's exam/batch.
    const elsewhere = await graderCreatesBatch(a, { examId: a.otherExamId });
    const sameExamOtherBatch = await graderCreatesBatch(a, {});
    for (const foreignPath of [elsewhere.ownPath, sameExamOtherBatch.ownPath]) {
      const { batchId, pageId } = await graderCreatesBatch(a, { imagePath: () => foreignPath });
      await graderProcesses(a, batchId);
      await expectRejectedWithoutReading(a, null, batchId, pageId);
    }
  });

  test("malformed and ambiguous paths are rejected", async () => {
    for (const malformed of [
      (batchId: number) => `classes/${a.classId}/exams/${a.examId}/batches/${batchId}/../../../../../${b.objectPath}`,
      (batchId: number) => `/classes/${a.classId}/exams/${a.examId}/batches/${batchId}/page-0.png`,
      (batchId: number) => `classes/${a.classId}/exams/${a.examId}/batches/${batchId}/sub/page-0.png`,
      () => b.objectPath.replace(/\//g, "%2F")
    ]) {
      const { batchId, pageId } = await graderCreatesBatch(a, { imagePath: malformed });
      await graderProcesses(a, batchId);
      await expectRejectedWithoutReading(a, b, batchId, pageId);
    }
  });

  test("swapping in course B's scan after review is rejected by match before it reads identity", async () => {
    const { batchId, pageId } = await graderCreatesBatch(a, {});
    expect((await graderProcesses(a, batchId)).status).toBe("review");
    const { error } = await a.grader.from("exam_scan_pages").update({ image_path: b.objectPath }).eq("id", pageId);
    expect(error).toBeNull();
    const { data: before } = await supabase
      .from("exam_scanned_submissions")
      .select("detected_name, detected_sis_id")
      .eq("batch_id", batchId)
      .single();
    // Re-processing skips OCR (already stored) and re-runs match, which reads identity from the image.
    const state = await graderProcesses(a, batchId);
    expect(state.status).toBe("error");
    expect(state.error ?? "").toMatch(/refusing to read it/);
    const { data: after } = await supabase
      .from("exam_scanned_submissions")
      .select("detected_name, detected_sis_id")
      .eq("batch_id", batchId)
      .single();
    expect(after).toEqual(before);
  });

  test("swapping in course B's scan after confirmation is rejected before finalize copies it", async () => {
    const { batchId, pageId } = await graderCreatesBatch(a, {});
    expect((await graderProcesses(a, batchId)).status).toBe("review");
    const { error: confirmErr } = await a.grader
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", batchId)
      .eq("matched_profile_id", a.student.private_profile_id);
    expect(confirmErr).toBeNull();
    const { error: swapErr } = await a.grader
      .from("exam_scan_pages")
      .update({ image_path: b.objectPath })
      .eq("id", pageId);
    expect(swapErr).toBeNull();
    const { data: queued, error: finErr } = await a.grader.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
    expect(finErr).toBeNull();
    expect(queued).toBe(1);
    // The copy happens before finalize's answer-region query, so this does not wait on #1075: stop
    // at the first of "batch errored" or "a page file was written for this exam".
    await expect
      .poll(
        async () => {
          await runExamWorker();
          const { count } = await supabase
            .from("submission_files")
            .select("id", { count: "exact", head: true })
            .eq("class_id", a.classId);
          return (await batch(batchId)).status === "error" || (count ?? 0) > 0;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe(true);
    const hashes = await courseASubmissionFileHashes(a);
    expect(hashes.stored).not.toContain(b.objectSha);
    expect(hashes.graderCanFetch).not.toContain(b.objectSha);
    expect(hashes.studentCanFetch).not.toContain(b.objectSha);
    const state = await batch(batchId);
    expect(state.status).toBe("error");
    expect(state.error ?? "").toMatch(/refusing to read it/);
  });

  test("the course-A grader cannot attach scan pages to, or queue work for, course B's batch", async () => {
    // Processing only ever reads pages by their batch, and a page's batch is coupled to its class
    // by the (batch_id, class_id) foreign key, so these links must all be refused by the database.
    const { batchId, pageId } = await graderCreatesBatch(a, {});
    const { error: insertErr } = await a.grader.from("exam_scan_pages").insert({
      class_id: a.classId,
      exam_id: a.examId,
      batch_id: b.batchId,
      page_index: 0,
      image_path: b.objectPath,
      width: 1000,
      height: 1400
    });
    expect(insertErr).not.toBeNull();
    const { error: moveErr } = await a.grader.from("exam_scan_pages").update({ batch_id: b.batchId }).eq("id", pageId);
    expect(moveErr).not.toBeNull();
    const { data: reclassed } = await a.grader
      .from("exam_scan_pages")
      .update({ class_id: b.classId })
      .eq("id", pageId)
      .select("id");
    expect(reclassed ?? []).toHaveLength(0);
    const { error: processErr } = await a.grader.rpc("enqueue_exam_process_batch", { p_batch_id: b.batchId });
    expect(processErr?.message ?? "").toMatch(/Access denied/);
    const { error: finalizeErr } = await a.grader.rpc("enqueue_exam_finalize", { p_batch_id: b.batchId });
    expect(finalizeErr?.message ?? "").toMatch(/Access denied/);
    const { data: page } = await supabase
      .from("exam_scan_pages")
      .select("class_id, batch_id")
      .eq("id", pageId)
      .single();
    expect(page).toEqual({ class_id: a.classId, batch_id: batchId });
    // The one link the database does not couple: a scanned submission's batch. The next test shows
    // the worker refusing to read through it.
    const { data: scanned } = await supabase
      .from("exam_scanned_submissions")
      .insert({ class_id: a.classId, exam_id: a.examId, batch_id: batchId, exam_index: 99 })
      .select("id")
      .single();
    const { data: retargeted, error: retargetErr } = await a.grader
      .from("exam_scanned_submissions")
      .update({ batch_id: b.batchId })
      .eq("id", scanned!.id)
      .select("batch_id")
      .single();
    expect(retargetErr).toBeNull();
    expect(retargeted?.batch_id).toBe(b.batchId);
  });

  test("retargeting a confirmed exam at course B's batch before finalize runs is rejected", async () => {
    // exam_scanned_submissions.batch_id is staff-writable and not tied to the row's class, so a
    // scope taken from it would let B's path validate. Finalize must judge ownership by the batch
    // its message was enqueued for.
    const { batchId, pageId } = await graderCreatesBatch(a, {});
    expect((await graderProcesses(a, batchId)).status).toBe("review");
    const { data: scanned } = await a.grader
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", batchId)
      .eq("matched_profile_id", a.student.private_profile_id)
      .select("id")
      .single();
    expect(scanned?.id).toBeTruthy();
    // Fixture: the exact message enqueue_exam_finalize sends for this batch (which the grader may
    // call), held back 5s so the grader's edits below land before a worker can read it instead of
    // racing the RPC's immediate worker ping.
    const { error: sendErr } = await supabase.schema("pgmq_public").rpc("send", {
      queue_name: "exam_processing",
      message: {
        method: "finalize",
        class_id: a.classId,
        batch_id: batchId,
        args: { scanned_submission_id: scanned!.id }
      },
      sleep_seconds: 5
    });
    expect(sendErr).toBeNull();
    await supabase.from("exam_scan_batches").update({ status: "finalizing" }).eq("id", batchId);
    // As the grader: point the scanned exam at course B's batch, and its page at B's object.
    const { error: retargetErr } = await a.grader
      .from("exam_scanned_submissions")
      .update({ batch_id: b.batchId })
      .eq("id", scanned!.id);
    expect(retargetErr).toBeNull();
    const { error: swapErr } = await a.grader
      .from("exam_scan_pages")
      .update({ image_path: b.objectPath })
      .eq("id", pageId);
    expect(swapErr).toBeNull();
    await expect
      .poll(
        async () => {
          await runExamWorker();
          const { count } = await supabase
            .from("submission_files")
            .select("id", { count: "exact", head: true })
            .eq("class_id", a.classId);
          return (await batch(batchId)).status === "error" || (count ?? 0) > 0;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe(true);
    const hashes = await courseASubmissionFileHashes(a);
    expect(hashes.stored).not.toContain(b.objectSha);
    expect(hashes.graderCanFetch).not.toContain(b.objectSha);
    expect(hashes.studentCanFetch).not.toContain(b.objectSha);
    expect((await batch(batchId)).status).toBe("error");
  });

  test("moving a confirmed exam to another exam of the same course is rejected before finalize creates anything", async () => {
    // The batch and the page path stay legitimate (exam X); only the scanned submission's exam_id
    // is changed to exam Y. exam_create_submission takes the assignment from that exam_id, so
    // accepting the row would file the student's scan under exam Y's assignment.
    const { data: exams } = await supabase
      .from("exams")
      .select("id, assignment_id")
      .in("id", [a.examId, a.otherExamId]);
    const assignmentOf = new Map((exams ?? []).map((e) => [e.id, e.assignment_id]));
    const assignments = [assignmentOf.get(a.examId)!, assignmentOf.get(a.otherExamId)!];
    // What finalize would create for this student: a submission, its page files, its exam artifact.
    const destination = async () => {
      const count = async (table: "submissions" | "submission_files" | "submission_artifacts") =>
        (
          await supabase
            .from(table)
            .select("id", { count: "exact", head: true })
            .eq("profile_id", a.student.private_profile_id)
            .eq("class_id", a.classId)
        ).count ?? 0;
      const { count: forExams } = await supabase
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("profile_id", a.student.private_profile_id)
        .in("assignment_id", assignments);
      return {
        submissions: await count("submissions"),
        examSubmissions: forExams ?? 0,
        files: await count("submission_files"),
        artifacts: await count("submission_artifacts")
      };
    };
    const before = await destination();

    const { batchId } = await graderCreatesBatch(a, {});
    expect((await graderProcesses(a, batchId)).status).toBe("review");
    // As the course-A grader: confirm, then move the scanned exam to exam Y. Both writes are accepted.
    const { data: scanned, error: confirmErr } = await a.grader
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", batchId)
      .eq("matched_profile_id", a.student.private_profile_id)
      .select("id")
      .single();
    expect(confirmErr).toBeNull();
    const { data: moved, error: moveErr } = await a.grader
      .from("exam_scanned_submissions")
      .update({ exam_id: a.otherExamId })
      .eq("id", scanned!.id)
      .select("exam_id, batch_id")
      .single();
    expect(moveErr).toBeNull();
    expect(moved).toEqual({ exam_id: a.otherExamId, batch_id: batchId });
    const { data: queued, error: finErr } = await a.grader.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
    expect(finErr).toBeNull();
    expect(queued).toBe(1);

    // Stop at the first of "batch errored" or "finalize created a submission for the row". The
    // submission is created before finalize's answer-region query, so this does not wait on #1075.
    await expect
      .poll(
        async () => {
          await runExamWorker();
          const { data: row } = await supabase
            .from("exam_scanned_submissions")
            .select("submission_id")
            .eq("id", scanned!.id)
            .single();
          return (await batch(batchId)).status === "error" || row?.submission_id != null;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe(true);
    const { data: row } = await supabase
      .from("exam_scanned_submissions")
      .select("submission_id, finalized_at")
      .eq("id", scanned!.id)
      .single();
    expect(row).toEqual({ submission_id: null, finalized_at: null });
    expect(await destination()).toEqual(before);
    const state = await batch(batchId);
    expect(state.status).toBe("error");
    expect(state.error ?? "").toMatch(/refusing to read its scans/);
  });

  test("a legitimate upload is processed and matched", async () => {
    const { batchId, pageId } = await graderCreatesBatch(a, {});
    expect((await graderProcesses(a, batchId)).status).toBe("review");
    const { data: page } = await supabase.from("exam_scan_pages").select("ocr_text").eq("id", pageId).single();
    expect(page?.ocr_text ?? "").toContain(`classes/${a.classId}/`);
    const { data: scanned } = await supabase
      .from("exam_scanned_submissions")
      .select("matched_profile_id, match_status")
      .eq("batch_id", batchId)
      .single();
    expect(scanned?.matched_profile_id).toBe(a.student.private_profile_id);
    expect(scanned?.match_status).toBe("suggested");
  });
});

// Requires #1075 (finalize's answer-region embed). Until that lands this fails at "completed",
// exactly as tests/e2e/exam-grading.spec.ts does.
test.describe("Exam scan ownership: legitimate finalization (#1078, needs #1075)", () => {
  test("a legitimate scan is finalized and its copy is readable by the grader and the student", async () => {
    test.setTimeout(120_000);
    const a = await arrangeCourseA();
    const { batchId, ownSha } = await graderCreatesBatch(a, {});
    expect((await graderProcesses(a, batchId)).status).toBe("review");
    await a.grader
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", batchId)
      .eq("matched_profile_id", a.student.private_profile_id);
    const { error } = await a.grader.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
    expect(error).toBeNull();
    await expect
      .poll(
        async () => {
          await runExamWorker();
          return (await batch(batchId)).status;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe("completed");
    const hashes = await courseASubmissionFileHashes(a);
    expect(hashes.count).toBe(1);
    expect(hashes.stored).toEqual([ownSha]);
    expect(hashes.graderCanFetch).toEqual([ownSha]);
    expect(hashes.studentCanFetch).toEqual([ownSha]);
  });
});
