import { expect } from "@playwright/test";
import { addDays } from "date-fns";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  setCourseFeature,
  setUserSisId,
  supabase
} from "./TestingUtils";

// A paper exam with one scanned batch, for specs that drive Scan & Match and finalize with the real
// exam worker. exam-grading.spec.ts builds the same thing inline for its own end-to-end checks.

// The `fake` vision provider reads identity from the object path (sis-<id>, name-<Name>), not pixels.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const FUNCTIONS_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const EDGE_SECRET = process.env.EDGE_FUNCTION_SECRET ?? "some-secret-value";

export async function runExamWorker(): Promise<void> {
  await fetch(`${FUNCTIONS_URL}/functions/v1/exam-async-worker`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-edge-function-secret": EDGE_SECRET },
    body: "{}"
  }).catch(() => {
    // best-effort; callers poll the database for the result
  });
}

export async function batchStatus(batchId: number): Promise<string | undefined> {
  const { data } = await supabase.from("exam_scan_batches").select("status").eq("id", batchId).single();
  return data?.status;
}

/** One scanned sheet: whose SIS id is written on it, and the name written on it (underscores for spaces). */
export type Sheet = { sis: "alice" | "bob" | "unknown"; name: string };

/**
 * A one-page exam with name and SIS regions, and an uploaded batch. By default the batch holds Alice,
 * Bob and an unknown sheet; `extraStudents` adds roster students that no sheet names.
 */
export async function seedUploadedBatch(
  label: string,
  {
    sheets = [
      { sis: "alice", name: "Alice_Smith" },
      { sis: "bob", name: "Bob_Jones" },
      { sis: "unknown", name: "Nobody_Here" }
    ],
    extraStudents = []
  }: { sheets?: Sheet[]; extraStudents?: string[] } = {}
) {
  const course = await createClass({ name: `Exam scan review UI ${label}` });
  await setCourseFeature(course.id, COURSE_FEATURES.EXAMS, true);
  const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
  const alice = await createUserInClass({ role: "student", class_id: course.id, name: "Alice Smith" });
  const bob = await createUserInClass({ role: "student", class_id: course.id, name: "Bob Jones" });
  // users.sis_user_id is globally unique; derive from the fresh class id (see exam-grading.spec.ts).
  const sisBase = 100000 + ((course.id * 10) % 2_000_000_000);
  await setUserSisId(alice.user_id, sisBase + 1);
  await setUserSisId(bob.user_id, sisBase + 2);
  const assignment = await insertAssignment({
    class_id: course.id,
    name: "Midterm Exam",
    assignment_type: "exam",
    due_date: addDays(new Date(), 7).toISOString()
  });

  const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
    p_assignment_id: assignment.id,
    p_source_type: "pdf",
    p_num_pages: 1
  });
  expect(examErr).toBeNull();
  await supabase.from("exam_template_pages").insert({
    class_id: course.id,
    exam_id: examId as number,
    page_number: 1,
    image_path: `classes/${course.id}/exams/${examId}/template/page-1.png`,
    width: 1000,
    height: 1400
  });
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
        answer_type: "free_text",
        points: 5
      }
    ],
    p_regions: [
      { question_client_id: "c1", kind: "answer", page_number: 1, x: 0.1, y: 0.3, width: 0.8, height: 0.2 },
      { question_client_id: null, kind: "student_id", page_number: 1, x: 0.1, y: 0.05, width: 0.5, height: 0.06 },
      { question_client_id: null, kind: "name", page_number: 1, x: 0.1, y: 0.12, width: 0.5, height: 0.06 }
    ]
  });
  expect(structErr).toBeNull();
  const { error: syncErr } = await supabase.rpc("exam_sync_rubric_from_questions", {
    p_exam_id: examId as number,
    p_rubric_id: assignment.grading_rubric_id as number
  });
  expect(syncErr).toBeNull();

  const extras = [];
  for (const name of extraStudents)
    extras.push(await createUserInClass({ role: "student", class_id: course.id, name }));
  const sisFor = { alice: sisBase + 1, bob: sisBase + 2, unknown: sisBase + 9 };
  const scans = sheets.map((sheet) => ({ sis: String(sisFor[sheet.sis]), name: sheet.name }));
  const { data: batch } = await supabase
    .from("exam_scan_batches")
    .insert({
      class_id: course.id,
      exam_id: examId as number,
      total_pages: scans.length,
      pages_per_exam: 1,
      status: "uploaded"
    })
    .select("id")
    .single();
  const batchId = batch!.id;
  for (let i = 0; i < scans.length; i++) {
    const path = `classes/${course.id}/exams/${examId}/batches/${batchId}/sis-${scans[i].sis}__name-${scans[i].name}__page-${i}.png`;
    const up = await supabase.storage
      .from("exam-scans")
      .upload(path, PNG_1x1, { contentType: "image/png", upsert: true });
    expect(up.error).toBeNull();
    const { error } = await supabase.from("exam_scan_pages").insert({
      class_id: course.id,
      exam_id: examId as number,
      batch_id: batchId,
      page_index: i,
      image_path: path,
      width: 1000,
      height: 1400
    });
    expect(error).toBeNull();
  }
  return { course, instructor, alice, bob, extras, assignment, examId: examId as number, batchId };
}

/** Runs the real OCR + match worker until the batch is in review. */
export async function processToReview(batchId: number) {
  const { error } = await supabase.rpc("enqueue_exam_process_batch", { p_batch_id: batchId });
  expect(error).toBeNull();
  await expect
    .poll(
      async () => {
        await runExamWorker();
        return batchStatus(batchId);
      },
      { timeout: 60_000, intervals: [1000, 2000, 3000] }
    )
    .toBe("review");
}
