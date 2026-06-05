import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import { createClass, createUserInClass, insertAssignment, setUserSisId, supabase } from "./TestingUtils";

// A 1x1 transparent PNG — enough bytes for storage upload; the `fake` vision
// provider derives identity/OCR from the object path, not the pixels.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const FUNCTIONS_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const EDGE_SECRET = process.env.EDGE_FUNCTION_SECRET ?? "some-secret-value";

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

test.describe("Exam grading OCR pipeline", () => {
  test("template -> rubric -> scan -> OCR/match -> finalize -> grader artifact", async () => {
    test.setTimeout(120_000);

    // --- 1) class, instructor, two students with SIS ids ---
    const course = await createClass({ name: "Exam OCR E2E" });
    await createUserInClass({ role: "instructor", class_id: course.id });
    const alice = await createUserInClass({ role: "student", class_id: course.id, name: "Alice Smith" });
    const bob = await createUserInClass({ role: "student", class_id: course.id, name: "Bob Jones" });
    // Unique SIS ids per run: users.sis_user_id is globally unique, so fixed ids would
    // collide across parallel browser projects and across re-runs against a persistent DB.
    const sisBase = 100000 + Math.floor(Math.random() * 800000);
    const aliceSis = sisBase + 1;
    const bobSis = sisBase + 2;
    const unknownSis = sisBase + 9; // intentionally never assigned -> stays unmatched
    await setUserSisId(alice.user_id, aliceSis);
    await setUserSisId(bob.user_id, bobSis);

    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Midterm Exam",
      due_date: addDays(new Date(), 7).toISOString()
    });
    expect(assignment.grading_rubric_id).toBeTruthy();

    // --- 2) exam template + 3-level question tree + regions ---
    const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
      p_assignment_id: assignment.id,
      p_source_type: "pdf",
      p_num_pages: 1
    });
    expect(examErr).toBeNull();
    expect(examId).toBeTruthy();

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
        { client_id: "p1", parent_client_id: null, level: 1, ordinal: 0, label: "Part A" },
        { client_id: "q1", parent_client_id: "p1", level: 2, ordinal: 0, label: "Q1" },
        {
          client_id: "c1",
          parent_client_id: "q1",
          level: 3,
          ordinal: 0,
          label: "Item 1",
          answer_type: "free_text",
          points: 5
        }
      ],
      p_regions: [
        { question_client_id: "c1", kind: "answer", page_number: 1, x: 0.1, y: 0.3, width: 0.8, height: 0.2 },
        { question_client_id: null, kind: "student_id", page_number: 1, x: 0.1, y: 0.05, width: 0.5, height: 0.06 },
        // both identity kinds defined -> the worker reads each and combines them
        { question_client_id: null, kind: "name", page_number: 1, x: 0.1, y: 0.12, width: 0.5, height: 0.06 }
      ]
    });
    expect(structErr).toBeNull();

    // --- 3) build the rubric from the exam structure and verify back-references ---
    const { error: syncErr } = await supabase.rpc("exam_sync_rubric_from_questions", {
      p_exam_id: examId as number,
      p_rubric_id: assignment.grading_rubric_id as number
    });
    expect(syncErr).toBeNull();

    const { data: parts } = await supabase
      .from("rubric_parts")
      .select("id, data")
      .eq("rubric_id", assignment.grading_rubric_id as number);
    const examParts = (parts ?? []).filter((p) => (p.data as { exam_question_id?: number } | null)?.exam_question_id);
    expect(examParts.length).toBeGreaterThanOrEqual(1);

    // --- 4) seed a scan batch: 3 single-page exams (Alice=111, Bob=222, unknown=999) ---
    const { data: batch } = await supabase
      .from("exam_scan_batches")
      .insert({
        class_id: course.id,
        exam_id: examId as number,
        total_pages: 3,
        pages_per_exam: 1,
        status: "uploaded"
      })
      .select("id")
      .single();
    const batchId = batch!.id;

    // The fake vision provider reads identity from the object path: sis-<id> drives the
    // student_id region, name-<Name> drives the name region. Alice/Bob carry a matching
    // name too (both signals agree); the unknown scan matches neither.
    const scans = [
      { sis: String(aliceSis), name: "Alice_Smith" },
      { sis: String(bobSis), name: "Bob_Jones" },
      { sis: String(unknownSis), name: "Nobody_Here" }
    ];
    for (let i = 0; i < scans.length; i++) {
      const path = `classes/${course.id}/exams/${examId}/batches/${batchId}/sis-${scans[i].sis}__name-${scans[i].name}__page-${i}.png`;
      const up = await supabase.storage.from("exam-scans").upload(path, PNG_1x1, {
        contentType: "image/png",
        upsert: true
      });
      expect(up.error).toBeNull();
      await supabase.from("exam_scan_pages").insert({
        class_id: course.id,
        exam_id: examId as number,
        batch_id: batchId,
        page_index: i,
        image_path: path,
        width: 1000,
        height: 1400
      });
    }

    // --- 5) process: OCR + split + match ---
    const { error: procErr } = await supabase.rpc("enqueue_exam_process_batch", { p_batch_id: batchId });
    expect(procErr).toBeNull();

    await expect
      .poll(
        async () => {
          await runExamWorker();
          const { data } = await supabase.from("exam_scan_batches").select("status").eq("id", batchId).single();
          return data?.status;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe("review");

    const { data: scanned } = await supabase
      .from("exam_scanned_submissions")
      .select("id, detected_sis_id, detected_name, matched_profile_id, match_status, match_confidence")
      .eq("batch_id", batchId)
      .order("exam_index");
    expect(scanned).toHaveLength(3);

    const byProfile = new Map((scanned ?? []).map((s) => [s.matched_profile_id, s]));
    const aliceScan = byProfile.get(alice.private_profile_id);
    const bobScan = byProfile.get(bob.private_profile_id);
    expect(aliceScan?.match_status).toBe("suggested");
    expect(bobScan?.match_status).toBe("suggested");
    // SIS id and name both resolve to the same student -> max confidence
    expect(aliceScan?.detected_name).toBe("Alice Smith");
    expect(aliceScan?.match_confidence).toBe(1);
    expect(bobScan?.match_confidence).toBe(1);
    const unmatched = (scanned ?? []).find((s) => s.detected_sis_id === String(unknownSis));
    expect(unmatched?.match_status).toBe("unmatched");

    // --- 6) confirm the two real matches, finalize ---
    await supabase
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", batchId)
      .not("matched_profile_id", "is", null);

    const { error: finErr } = await supabase.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
    expect(finErr).toBeNull();

    await expect
      .poll(
        async () => {
          await runExamWorker();
          const { data } = await supabase.from("exam_scan_batches").select("status").eq("id", batchId).single();
          return data?.status;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe("completed");

    // --- 7) assert submissions, raw files, and the exam_v1 artifact exist ---
    const { data: submissions } = await supabase
      .from("submissions")
      .select("id, profile_id, grading_review_id")
      .eq("assignment_id", assignment.id);
    expect(submissions).toHaveLength(2);
    for (const s of submissions ?? []) {
      expect(s.grading_review_id).toBeTruthy(); // submissions_after_insert_hook ran

      const { data: files } = await supabase
        .from("submission_files")
        .select("id, is_binary, mime_type")
        .eq("submission_id", s.id);
      expect((files ?? []).length).toBeGreaterThanOrEqual(1);
      expect((files ?? [])[0].mime_type).toBe("image/png");

      const { data: artifacts } = await supabase
        .from("submission_artifacts")
        .select("id, data")
        .eq("submission_id", s.id);
      const examArtifact = (artifacts ?? []).find((a) => (a.data as { format?: string } | null)?.format === "exam_v1");
      expect(examArtifact).toBeTruthy();
      const data = examArtifact!.data as { questions: { ocr_text: string }[] };
      expect(Array.isArray(data.questions)).toBe(true);
      expect(data.questions.length).toBeGreaterThanOrEqual(1);
    }

    // negative: the unmatched exam was never turned into a submission
    const { data: stillUnmatched } = await supabase
      .from("exam_scanned_submissions")
      .select("submission_id")
      .eq("id", unmatched!.id)
      .single();
    expect(stillUnmatched?.submission_id).toBeNull();

    // --- 8) crash-safety: re-finalizing a completed batch is a no-op ---
    const { data: reCountDone } = await supabase.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
    expect(reCountDone).toBe(0); // every confirmed submission already has its artifact

    // --- 9) crash-safety: a finalize that died before writing the artifact resumes ---
    // Simulate the crash by dropping one submission's exam artifact, then re-finalize.
    const victim = (submissions ?? [])[0]!;
    const { data: filesBefore } = await supabase.from("submission_files").select("id").eq("submission_id", victim.id);
    await supabase.from("submission_artifacts").delete().eq("submission_id", victim.id).eq("data->>format", "exam_v1");

    // only the one submission missing its artifact gets re-enqueued
    const { data: reCount } = await supabase.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
    expect(reCount).toBe(1);

    await expect
      .poll(
        async () => {
          await runExamWorker();
          const { data } = await supabase.from("exam_scan_batches").select("status").eq("id", batchId).single();
          return data?.status;
        },
        { timeout: 60_000, intervals: [1000, 2000, 3000] }
      )
      .toBe("completed");

    // artifact restored exactly once, and page files rebuilt — not duplicated
    const { data: artAfter } = await supabase
      .from("submission_artifacts")
      .select("id, data")
      .eq("submission_id", victim.id);
    expect((artAfter ?? []).filter((a) => (a.data as { format?: string } | null)?.format === "exam_v1")).toHaveLength(
      1
    );
    const { data: filesAfter } = await supabase.from("submission_files").select("id").eq("submission_id", victim.id);
    expect(filesAfter ?? []).toHaveLength((filesBefore ?? []).length);
  });
});
