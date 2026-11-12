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

/**
 * The ids of every row finalize can create in a course: submissions, the grading reviews
 * submissions_after_insert_hook creates with them, page files and exam artifacts. Compared before
 * and after, so a rejected finalize is shown to add no row, not merely to keep the totals.
 */
async function courseRowIds(classId: number) {
  const ids = async (table: "submissions" | "submission_reviews" | "submission_files" | "submission_artifacts") => {
    const { data, error } = await supabase.from(table).select("id").eq("class_id", classId).order("id");
    expect(error).toBeNull();
    return (data ?? []).map((r) => r.id);
  };
  return {
    submissions: await ids("submissions"),
    reviews: await ids("submission_reviews"),
    files: await ids("submission_files"),
    artifacts: await ids("submission_artifacts")
  };
}

/**
 * As `staff`, try to change a scanned exam's batch, exam or class. The database must refuse it and
 * leave the row exactly as it was: finalize checks these columns and exam_create_submission then
 * re-reads them, so a change landing in between would otherwise go unchecked.
 */
async function expectScopeChangeRefused(
  staff: SupabaseClient<Database>,
  scannedId: number,
  change: { batch_id?: number; exam_id?: number; class_id?: number }
) {
  const scope = async () => {
    const { data, error } = await supabase
      .from("exam_scanned_submissions")
      .select("class_id, exam_id, batch_id")
      .eq("id", scannedId)
      .single();
    expect(error).toBeNull();
    return data;
  };
  const before = await scope();
  const { error } = await staff.from("exam_scanned_submissions").update(change).eq("id", scannedId).select("id");
  expect(error?.message ?? "").toMatch(/cannot change after it is created/);
  expect(await scope()).toEqual(before);
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

  test("swapping in course B's scan after confirmation is rejected before finalize creates anything", async () => {
    // Every submission, grading review, file and artifact in course A, by id.
    const before = await courseRowIds(a.classId);
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
    const { data: row } = await supabase
      .from("exam_scanned_submissions")
      .select("submission_id, finalized_at")
      .eq("batch_id", batchId)
      .eq("matched_profile_id", a.student.private_profile_id)
      .single();
    expect(row).toEqual({ submission_id: null, finalized_at: null });
    expect(await courseRowIds(a.classId)).toEqual(before);
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
    // A scanned exam's batch is not coupled to its class by a foreign key, but once the row exists
    // it cannot be repointed. The next test covers the worker's own check for a row that names
    // another batch.
    const { data: scanned, error: insertScannedErr } = await supabase
      .from("exam_scanned_submissions")
      .insert({ class_id: a.classId, exam_id: a.examId, batch_id: batchId, exam_index: 99 })
      .select("id")
      .single();
    expect(insertScannedErr).toBeNull();
    await expectScopeChangeRefused(a.grader, scanned!.id, { batch_id: b.batchId });
  });

  test("a confirmed exam cannot be retargeted at course B's batch, and finalize refuses a row from another batch", async () => {
    // exam_scanned_submissions.batch_id is not tied to the row's class, so a scope taken from it
    // would let B's path validate. The database refuses to change it once the row exists, and
    // finalize still judges ownership by the batch its message was enqueued for.
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
    await expectScopeChangeRefused(a.grader, scanned!.id, { batch_id: b.batchId });

    // The worker's own check, for a row that names another batch from the start: row RLS still
    // lets the course-A grader insert one pointing at B's batch, with this batch's page linked to
    // it and swapped to B's object.
    const { data: foreign, error: foreignErr } = await a.grader
      .from("exam_scanned_submissions")
      .insert({
        class_id: a.classId,
        exam_id: a.examId,
        batch_id: b.batchId,
        exam_index: 1000 + Math.floor(Math.random() * 1_000_000),
        matched_profile_id: a.student.private_profile_id,
        match_status: "confirmed"
      })
      .select("id, batch_id")
      .single();
    expect(foreignErr).toBeNull();
    expect(foreign?.batch_id).toBe(b.batchId);
    const { data: relinked, error: relinkErr } = await a.grader
      .from("exam_scan_pages")
      .update({ scanned_submission_id: foreign!.id, image_path: b.objectPath })
      .eq("id", pageId)
      .select("scanned_submission_id, image_path");
    expect(relinkErr).toBeNull();
    expect(relinked).toEqual([{ scanned_submission_id: foreign!.id, image_path: b.objectPath }]);
    const before = await courseRowIds(a.classId);
    // Fixture: a finalize message for this batch naming that row (enqueue_exam_finalize only queues
    // a batch's own rows, so this is the worker's defence in depth, not an RPC path).
    await sendExamMessage({
      method: "finalize",
      class_id: a.classId,
      batch_id: batchId,
      args: { scanned_submission_id: foreign!.id }
    });
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
    expect(state.error ?? "").toMatch(/is no longer in batch/);
    expect(await courseRowIds(a.classId)).toEqual(before);
  });

  test("a confirmed exam cannot be moved to another exam of the same course, and finalize refuses a row whose exam is not its batch's", async () => {
    // The batch and the page path stay legitimate (exam X); only the scanned submission names exam
    // Y. exam_create_submission takes the assignment from that exam_id, so accepting the row would
    // file the student's scan under exam Y's assignment.
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

    const { batchId, pageId } = await graderCreatesBatch(a, {});
    expect((await graderProcesses(a, batchId)).status).toBe("review");
    // As the course-A grader: the processed exam cannot be moved to exam Y.
    const { data: processed, error: processedErr } = await supabase
      .from("exam_scanned_submissions")
      .select("id")
      .eq("batch_id", batchId)
      .single();
    expect(processedErr).toBeNull();
    await expectScopeChangeRefused(a.grader, processed!.id, { exam_id: a.otherExamId });

    // The worker's own check: row RLS still lets the grader insert a confirmed exam for this batch
    // that names exam Y, and enqueue_exam_finalize queues it. This batch's page is linked to it, so
    // without the check finalize would file the scan under exam Y's assignment. (The processed row
    // stays unconfirmed, so the RPC's one-confirmed-exam-per-student guard does not fire.)
    const { data: scanned, error: insertErr } = await a.grader
      .from("exam_scanned_submissions")
      .insert({
        class_id: a.classId,
        exam_id: a.otherExamId,
        batch_id: batchId,
        exam_index: 99,
        matched_profile_id: a.student.private_profile_id,
        match_status: "confirmed"
      })
      .select("id, exam_id, batch_id")
      .single();
    expect(insertErr).toBeNull();
    expect(scanned).toMatchObject({ exam_id: a.otherExamId, batch_id: batchId });
    const { data: linked, error: linkErr } = await a.grader
      .from("exam_scan_pages")
      .update({ scanned_submission_id: scanned!.id })
      .eq("id", pageId)
      .select("scanned_submission_id");
    expect(linkErr).toBeNull();
    expect(linked).toEqual([{ scanned_submission_id: scanned!.id }]);
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
    expect(state.error ?? "").toMatch(/names exam \d+, but batch \d+ is exam \d+; refusing to read its scans/);
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

  test("a finalize that stopped after creating the submission is resumed with that same submission", async () => {
    test.setTimeout(120_000);
    const a = await arrangeCourseA();
    const { batchId, ownSha } = await graderCreatesBatch(a, {});
    expect((await graderProcesses(a, batchId)).status).toBe("review");
    const { data: confirmed, error: confirmErr } = await a.grader
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", batchId)
      .eq("matched_profile_id", a.student.private_profile_id)
      .select("id")
      .single();
    expect(confirmErr).toBeNull();
    // Fixture: the state an earlier finalize attempt leaves when it stops right after
    // exam_create_submission (a crash, or a failure later in that attempt).
    const { data: subId, error: createErr } = await supabase.rpc("exam_create_submission", {
      p_scanned_submission_id: confirmed!.id
    });
    expect(createErr).toBeNull();
    expect(typeof subId).toBe("number");
    const countFor = async (table: "submission_files" | "submission_artifacts") =>
      (
        await supabase
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq("submission_id", subId as number)
      ).count ?? 0;
    const { data: partial } = await supabase
      .from("exam_scanned_submissions")
      .select("submission_id, finalized_at")
      .eq("id", confirmed!.id)
      .single();
    expect(partial).toEqual({ submission_id: subId, finalized_at: null });
    expect(await countFor("submission_files")).toBe(0);
    expect(await countFor("submission_artifacts")).toBe(0);

    const { data: queued, error } = await a.grader.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
    expect(error).toBeNull();
    expect(queued).toBe(1);
    await expect
      .poll(
        async () => {
          await runExamWorker();
          return (await batch(batchId)).status;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe("completed");
    const { data: subs } = await supabase
      .from("submissions")
      .select("id")
      .eq("class_id", a.classId)
      .eq("profile_id", a.student.private_profile_id);
    expect(subs).toEqual([{ id: subId }]);
    const { data: done } = await supabase
      .from("exam_scanned_submissions")
      .select("submission_id, finalized_at")
      .eq("id", confirmed!.id)
      .single();
    expect(done?.submission_id).toBe(subId);
    expect(done?.finalized_at).not.toBeNull();
    const hashes = await courseASubmissionFileHashes(a);
    expect(hashes.count).toBe(1);
    expect(hashes.stored).toEqual([ownSha]);
    expect(await countFor("submission_artifacts")).toBe(1);
  });

  test("a partial submission survives a rejected finalize, and is resumed once the scan is fixed", async () => {
    test.setTimeout(180_000);
    const a = await arrangeCourseA();
    const b = await arrangeCourseB();
    const { batchId, pageId, ownPath, ownSha } = await graderCreatesBatch(a, {});
    expect((await graderProcesses(a, batchId)).status).toBe("review");
    const { data: confirmed, error: confirmErr } = await a.grader
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", batchId)
      .eq("matched_profile_id", a.student.private_profile_id)
      .select("id")
      .single();
    expect(confirmErr).toBeNull();
    // Fixture: what an earlier finalize attempt leaves when it stops after exam_create_submission.
    const { data: subId, error: createErr } = await supabase.rpc("exam_create_submission", {
      p_scanned_submission_id: confirmed!.id
    });
    expect(createErr).toBeNull();
    expect(typeof subId).toBe("number");
    const submissionRow = async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("*")
        .eq("id", subId as number)
        .single();
      expect(error).toBeNull();
      return data;
    };
    const scannedRow = async () => {
      const { data, error } = await supabase
        .from("exam_scanned_submissions")
        .select("submission_id, finalized_at, match_status, matched_profile_id")
        .eq("id", confirmed!.id)
        .single();
      expect(error).toBeNull();
      return data;
    };
    const partialSubmission = await submissionRow();
    const partialScanned = await scannedRow();
    expect(partialScanned).toEqual({
      submission_id: subId,
      finalized_at: null,
      match_status: "confirmed",
      matched_profile_id: a.student.private_profile_id
    });
    const beforeRejection = await courseRowIds(a.classId);
    expect(beforeRejection.submissions).toEqual([subId]);
    expect(beforeRejection.reviews.length).toBeGreaterThan(0); // created by the insert hook
    expect(beforeRejection.files).toEqual([]);
    expect(beforeRejection.artifacts).toEqual([]);

    // As the grader: swap course B's object into the confirmed exam's page, then finalize.
    const { data: swapped, error: swapErr } = await a.grader
      .from("exam_scan_pages")
      .update({ image_path: b.objectPath })
      .eq("id", pageId)
      .select("image_path");
    expect(swapErr).toBeNull();
    expect(swapped).toEqual([{ image_path: b.objectPath }]);
    const { data: queued, error: finErr } = await a.grader.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
    expect(finErr).toBeNull();
    expect(queued).toBe(1);
    await expect
      .poll(
        async () => {
          await runExamWorker();
          return (await batch(batchId)).status;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe("error");
    expect((await batch(batchId)).error ?? "").toMatch(/refusing to read it/);
    // Nothing added, and the partial submission and its scanned exam are exactly as they were.
    expect(await courseRowIds(a.classId)).toEqual(beforeRejection);
    expect(await submissionRow()).toEqual(partialSubmission);
    expect(await scannedRow()).toEqual(partialScanned);
    expect((await courseASubmissionFileHashes(a)).stored).not.toContain(b.objectSha);

    // As the grader: put the page's own scan back, and finalize again.
    const { data: restored, error: restoreErr } = await a.grader
      .from("exam_scan_pages")
      .update({ image_path: ownPath })
      .eq("id", pageId)
      .select("image_path");
    expect(restoreErr).toBeNull();
    expect(restored).toEqual([{ image_path: ownPath }]);
    const { data: requeued, error: refinErr } = await a.grader.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
    expect(refinErr).toBeNull();
    expect(requeued).toBe(1);
    await expect
      .poll(
        async () => {
          await runExamWorker();
          return (await batch(batchId)).status;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe("completed");
    const after = await courseRowIds(a.classId);
    expect(after.submissions).toEqual([subId]);
    expect(after.reviews).toEqual(beforeRejection.reviews);
    expect(after.files).toHaveLength(1);
    expect(after.artifacts).toHaveLength(1);
    const done = await scannedRow();
    expect(done?.submission_id).toBe(subId);
    expect(done?.finalized_at).not.toBeNull();
    const hashes = await courseASubmissionFileHashes(a);
    expect(hashes.stored).toEqual([ownSha]);
    expect(hashes.studentCanFetch).toEqual([ownSha]);
  });
});

/** Send one exam_processing message, shaped as enqueue_exam_* sends it, and return its pgmq id. */
async function sendExamMessage(message: Record<string, unknown>): Promise<number> {
  const { data, error } = await supabase.schema("pgmq_public").rpc("send", {
    queue_name: "exam_processing",
    message: message as never,
    sleep_seconds: 0
  });
  expect(error).toBeNull();
  const id = Array.isArray(data) ? data[0] : data;
  expect(typeof id).toBe("number");
  return id as number;
}

/**
 * Drive the worker until the sentinel page has been OCR'd. Callers send the sentinel's process_page
 * message right after the message under test, so it has the higher msg_id and becomes visible no
 * earlier. The worker claims visible messages lowest id first and handles each read in order, so
 * once the sentinel is done the message under test has been claimed too; two more kicks give an
 * invocation that claimed it separately time to finish. A job that correctly does nothing leaves
 * nothing to observe, so this ordering is the evidence that it ran.
 */
async function drainThrough(sentinelPageId: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await runExamWorker();
        const { data } = await supabase.from("exam_scan_pages").select("ocr_data").eq("id", sentinelPageId).single();
        return data?.ocr_data != null;
      },
      { timeout: 60_000, intervals: [1000, 2000, 3000] }
    )
    .toBe(true);
  for (let i = 0; i < 2; i++) {
    await runExamWorker();
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Send `target`, then a sentinel process_page for a fresh page of course A, and drain through it. */
async function runQueuedThroughSentinel(a: CourseA, target: Record<string, unknown>): Promise<void> {
  const sentinel = await graderCreatesBatch(a, {});
  const targetMsgId = await sendExamMessage(target);
  const sentinelMsgId = await sendExamMessage({
    method: "process_page",
    class_id: a.classId,
    batch_id: sentinel.batchId,
    args: { scan_page_id: sentinel.pageId }
  });
  test.info().annotations.push({
    type: "exam-queue",
    description: JSON.stringify({ targetMsgId, sentinelMsgId, target })
  });
  await drainThrough(sentinel.pageId);
}

const SEEDED_OCR = { ocr_text: "read earlier", ocr_data: { words: [] } };

/** As the service role: record OCR for every page of a batch, as process_page would have, and check it. */
async function seedOcr(batchId: number, expectedPages: number): Promise<void> {
  const { data, error } = await supabase
    .from("exam_scan_pages")
    .update(SEEDED_OCR)
    .eq("batch_id", batchId)
    .select("id, ocr_text, ocr_data");
  expect(error).toBeNull();
  expect(data).toHaveLength(expectedPages);
  for (const p of data ?? []) expect({ ocr_text: p.ocr_text, ocr_data: p.ocr_data }).toEqual(SEEDED_OCR);
}

async function scannedRowsFor(batchId: number): Promise<number> {
  const { count } = await supabase
    .from("exam_scanned_submissions")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId);
  return count ?? 0;
}

// Queued work is authorized by the batch it was enqueued for. These cover a job that outlived a
// change to that batch: a page staff moved out, pages deleted after enqueue, or a batch that has
// already errored or completed.
test.describe("Exam worker: queued work that no longer matches its batch (#1078)", () => {
  let a: CourseA;
  test.beforeAll(async () => {
    a = await arrangeCourseA();
  });

  /** As the grader: move X's page into batch Y at page_index 1, pointing at Y's own object. */
  async function graderMovesPage(
    pageId: number,
    y: { batchId: number; ownPath: string },
    expectedOcr: { ocr_text: string | null; ocr_data: unknown }
  ) {
    const { data: moved, error } = await a.grader
      .from("exam_scan_pages")
      .update({ batch_id: y.batchId, page_index: 1, image_path: y.ownPath })
      .eq("id", pageId)
      .select("batch_id, page_index, image_path")
      .single();
    expect(error).toBeNull();
    expect(moved).toEqual({ batch_id: y.batchId, page_index: 1, image_path: y.ownPath });
    const { data: stored } = await supabase
      .from("exam_scan_pages")
      .select("class_id, batch_id, page_index, image_path, ocr_text, ocr_data")
      .eq("id", pageId)
      .single();
    expect(stored).toEqual({
      class_id: a.classId,
      batch_id: y.batchId,
      page_index: 1,
      image_path: y.ownPath,
      ...expectedOcr
    });
  }

  test("an OCR job for a page that has since moved to another batch does not OCR it", async () => {
    const x = await graderCreatesBatch(a, {});
    const y = await graderCreatesBatch(a, {});
    await graderMovesPage(x.pageId, y, { ocr_text: null, ocr_data: null });
    // The message enqueue_exam_process_batch sent for X before the page moved.
    await runQueuedThroughSentinel(a, {
      method: "process_page",
      class_id: a.classId,
      batch_id: x.batchId,
      args: { scan_page_id: x.pageId }
    });
    // The fake provider's OCR text names the object it read, so a stored result would show Y's path.
    const { data: page } = await supabase
      .from("exam_scan_pages")
      .select("ocr_text, ocr_data")
      .eq("id", x.pageId)
      .single();
    expect(page).toEqual({ ocr_text: null, ocr_data: null });
    // Obsolete work is a no-op, not a failure of the batch it was queued for.
    expect(await batch(x.batchId)).toEqual({ status: "uploaded", error: null });
    const { data: dlq } = await supabase
      .from("exam_async_worker_dlq_messages")
      .select("id")
      .eq("class_id", a.classId)
      .eq("envelope->>batch_id", String(x.batchId));
    expect(dlq).toEqual([]);
  });

  test("a duplicate OCR job for a page that was read and then moved leaves its OCR as it was", async () => {
    const x = await graderCreatesBatch(a, {});
    const y = await graderCreatesBatch(a, {});
    await seedOcr(x.batchId, 1);
    await graderMovesPage(x.pageId, y, SEEDED_OCR);
    await runQueuedThroughSentinel(a, {
      method: "process_page",
      class_id: a.classId,
      batch_id: x.batchId,
      args: { scan_page_id: x.pageId }
    });
    const { data: page } = await supabase
      .from("exam_scan_pages")
      .select("ocr_text, ocr_data")
      .eq("id", x.pageId)
      .single();
    expect(page).toEqual(SEEDED_OCR);
  });

  test("matching refuses a batch that lost a page after it was queued, even when the rest divide into exams", async () => {
    // Two declared pages at one page per exam, so one remaining page still divides evenly.
    const { data: b, error: batchErr } = await a.grader
      .from("exam_scan_batches")
      .insert({ class_id: a.classId, exam_id: a.examId, total_pages: 2, pages_per_exam: 1, status: "uploaded" })
      .select("id")
      .single();
    expect(batchErr).toBeNull();
    const pageIds: number[] = [];
    for (const i of [0, 1]) {
      const path = `classes/${a.classId}/exams/${a.examId}/batches/${b!.id}/sis-${a.studentSis}__name-Alice_Smith__page-${i}.png`;
      const bytes = Buffer.concat([PNG_1x1, Buffer.from(`course-A-scan-${randomUUID()}`)]);
      const up = await a.grader.storage.from("exam-scans").upload(path, bytes, { contentType: "image/png" });
      expect(up.error).toBeNull();
      const { data: page, error: pageErr } = await a.grader
        .from("exam_scan_pages")
        .insert({
          class_id: a.classId,
          exam_id: a.examId,
          batch_id: b!.id,
          page_index: i,
          image_path: path,
          width: 1000,
          height: 1400
        })
        .select("id")
        .single();
      expect(pageErr).toBeNull();
      pageIds.push(page!.id);
    }
    // OCR is already done, so match's wait for the OCR fan-out is satisfied.
    await seedOcr(b!.id, 2);
    // As the grader, after enqueue_exam_process_batch accepted 2 of 2 pages: delete the second.
    const { data: deleted, error: deleteErr } = await a.grader
      .from("exam_scan_pages")
      .delete()
      .eq("id", pageIds[1])
      .select("id");
    expect(deleteErr).toBeNull();
    expect(deleted).toEqual([{ id: pageIds[1] }]);
    const { data: left } = await supabase.from("exam_scan_pages").select("id, ocr_data").eq("batch_id", b!.id);
    expect(left?.map((p) => p.id)).toEqual([pageIds[0]]);
    expect(left?.[0].ocr_data).not.toBeNull();
    const { data: declared } = await supabase
      .from("exam_scan_batches")
      .select("total_pages, pages_per_exam, status")
      .eq("id", b!.id)
      .single();
    expect(declared).toEqual({ total_pages: 2, pages_per_exam: 1, status: "uploaded" });

    // The match message as it looks on its last retry. The check is deterministic, so every attempt
    // fails it the same way; on the last one the dispatcher records the error now rather than after
    // about five minutes of backoff. This shows the check and its terminal outcome, not the retries.
    await sendExamMessage({
      method: "match",
      class_id: a.classId,
      batch_id: b!.id,
      args: { batch_id: b!.id },
      retry_count: 5
    });
    await expect
      .poll(
        async () => {
          await runExamWorker();
          return (await batch(b!.id)).status;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toMatch(/^(error|review)$/);
    const state = await batch(b!.id);
    expect(state.status).toBe("error");
    expect(state.error ?? "").toMatch(/has 1 of 2 scan pages/);
    const { data: dlq } = await supabase
      .from("exam_async_worker_dlq_messages")
      .select("method, error_message")
      .eq("class_id", a.classId)
      .eq("envelope->>batch_id", String(b!.id));
    expect(dlq).toHaveLength(1);
    expect(dlq?.[0].method).toBe("match");
    expect(dlq?.[0].error_message ?? "").toMatch(/has 1 of 2 scan pages/);
    expect(await scannedRowsFor(b!.id)).toBe(0);
  });

  test("a scan rejection that arrives after the batch completed leaves it completed", async () => {
    const x = await graderCreatesBatch(a, {});
    expect((await graderProcesses(a, x.batchId)).status).toBe("review");
    const { data: confirmed, error: confirmErr } = await a.grader
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", x.batchId)
      .eq("matched_profile_id", a.student.private_profile_id)
      .select("id")
      .single();
    expect(confirmErr).toBeNull();
    // As the grader: point the confirmed exam's page at another batch's object, which finalize
    // refuses to read.
    const other = await graderCreatesBatch(a, {});
    const { data: swapped, error: swapErr } = await a.grader
      .from("exam_scan_pages")
      .update({ image_path: other.ownPath })
      .eq("id", x.pageId)
      .select("image_path");
    expect(swapErr).toBeNull();
    expect(swapped).toEqual([{ image_path: other.ownPath }]);
    // Fixture: the batch as a duplicate finalize worker finds it when it rejects late. Another
    // worker already finished this exam and completed the batch, after this one read the row and
    // before finalized_at was stamped.
    const { data: set, error: setErr } = await supabase
      .from("exam_scan_batches")
      .update({ status: "completed", error: null })
      .eq("id", x.batchId)
      .select("status, error")
      .single();
    expect(setErr).toBeNull();
    expect(set).toEqual({ status: "completed", error: null });
    const before = await courseRowIds(a.classId);

    await runQueuedThroughSentinel(a, {
      method: "finalize",
      class_id: a.classId,
      batch_id: x.batchId,
      args: { scanned_submission_id: confirmed!.id }
    });
    // The rejection still happened and was dead-lettered...
    const { data: dlq } = await supabase
      .from("exam_async_worker_dlq_messages")
      .select("method, error_type")
      .eq("class_id", a.classId)
      .eq("envelope->>batch_id", String(x.batchId));
    expect(dlq).toEqual([{ method: "finalize", error_type: "ScanPathRejectedError" }]);
    // ...but it does not turn the completed batch into an error.
    expect(await batch(x.batchId)).toEqual({ status: "completed", error: null });
    expect(await courseRowIds(a.classId)).toEqual(before);
  });

  for (const terminal of ["error", "completed"] as const) {
    test(`a stale match job leaves a batch in '${terminal}' as it is`, async () => {
      const x = await graderCreatesBatch(a, {});
      await seedOcr(x.batchId, 1);
      const earlier = terminal === "error" ? "an earlier failure staff still need to read" : null;
      const { data: set, error: setErr } = await supabase
        .from("exam_scan_batches")
        .update({ status: terminal, error: earlier })
        .eq("id", x.batchId)
        .select("status, error, total_pages")
        .single();
      expect(setErr).toBeNull();
      expect(set).toEqual({ status: terminal, error: earlier, total_pages: 1 });
      // Otherwise matchable: every declared page is present and OCR'd.
      const { data: pages } = await supabase.from("exam_scan_pages").select("ocr_data").eq("batch_id", x.batchId);
      expect(pages).toHaveLength(1);
      expect(pages?.[0].ocr_data).not.toBeNull();

      await runQueuedThroughSentinel(a, {
        method: "match",
        class_id: a.classId,
        batch_id: x.batchId,
        args: { batch_id: x.batchId }
      });
      expect(await batch(x.batchId)).toEqual({ status: terminal, error: earlier });
      expect(await scannedRowsFor(x.batchId)).toBe(0);

      if (terminal === "error") {
        // Explicit reprocessing is how staff recover an errored batch, and it still works.
        const { error: reErr } = await a.grader.rpc("enqueue_exam_process_batch", { p_batch_id: x.batchId });
        expect(reErr).toBeNull();
        await expect
          .poll(
            async () => {
              await runExamWorker();
              return (await batch(x.batchId)).status;
            },
            { timeout: 60_000, intervals: [1000, 2000, 3000] }
          )
          .toBe("review");
        const { data: scanned } = await supabase
          .from("exam_scanned_submissions")
          .select("matched_profile_id, match_status")
          .eq("batch_id", x.batchId)
          .single();
        expect(scanned).toEqual({ matched_profile_id: a.student.private_profile_id, match_status: "suggested" });
      }
    });
  }
});
