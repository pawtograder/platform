import { expect, test, type Page } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  getAuthTokenForUser,
  insertAssignment,
  setUserSisId,
  supabase
} from "./TestingUtils";

// Exam OCR against the REAL Google Vision + Gemini APIs.
//
// exam-grading.spec.ts covers the pipeline's bookkeeping with the offline `fake` provider, which
// reads identity from the storage path and never looks at a pixel. This suite renders real exam
// pages, so it is the only check that the Vision request/response mapping, the Gemini prompts,
// the configured model and the API key all still work. It runs only from exam-vision-e2e.yml
// (playwright.vision.config.ts); the default config ignores *.vision.spec.ts.
//
// Assertions are about what the pipeline must get right on clean printed text (SIS ids, names,
// short answers), not about exact OCR strings, which the providers are free to vary.

const FUNCTIONS_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const EDGE_SECRET = process.env.EDGE_FUNCTION_SECRET ?? "some-secret-value";

// US letter at 100 dpi. Region coordinates below are fractions of this page.
const PAGE_W = 850;
const PAGE_H = 1100;

type Rect = { x: number; y: number; width: number; height: number };
const SIS_REGION: Rect = { x: 0.08, y: 0.08, width: 0.6, height: 0.07 };
const NAME_REGION: Rect = { x: 0.08, y: 0.17, width: 0.6, height: 0.07 };
const Q1_REGION: Rect = { x: 0.08, y: 0.36, width: 0.84, height: 0.14 };
const Q2_REGION: Rect = { x: 0.08, y: 0.62, width: 0.84, height: 0.1 };

type Filled = { sis: string; name: string; q1: string; q2: string };

function pct(n: number) {
  return `${(n * 100).toFixed(2)}%`;
}

function box(r: Rect, label: string, value: string) {
  return `<div class="box" style="left:${pct(r.x)};top:${pct(r.y)};width:${pct(r.width)};height:${pct(r.height)}">
    <span class="label">${label}</span><span class="value">${value}</span></div>`;
}

/** Render one exam page (blank template when `filled` is omitted) to a PNG. */
async function renderExamPage(page: Page, filled?: Filled): Promise<Buffer> {
  await page.setViewportSize({ width: PAGE_W, height: PAGE_H });
  // Prompts sit above their answer boxes, outside the regions, so the region crop holds only
  // the student's answer (wordsInRegion keeps words whose centre is inside the rect).
  await page.setContent(`<!doctype html><html><head><style>
      html, body { margin: 0; width: ${PAGE_W}px; height: ${PAGE_H}px; background: #fff; }
      body { position: relative; font-family: Arial, Helvetica, sans-serif; color: #000; }
      .title { position: absolute; left: 8%; top: 2%; font-size: 30px; font-weight: bold; }
      .prompt { position: absolute; left: 8%; font-size: 20px; }
      .box { position: absolute; box-sizing: border-box; border: 2px solid #000; padding: 12px 16px;
             display: flex; align-items: center; gap: 18px; }
      .label { font-size: 18px; }
      .value { font-size: 32px; letter-spacing: 1px; }
    </style></head><body>
      <div class="title">CS 3100 Midterm Exam</div>
      ${box(SIS_REGION, "Student ID:", filled?.sis ?? "")}
      ${box(NAME_REGION, "Name:", filled?.name ?? "")}
      <div class="prompt" style="top:${pct(Q1_REGION.y - 0.06)}">Part A, Question 1 (5 points): Which design pattern decouples an event source from its listeners?</div>
      ${box(Q1_REGION, "", filled?.q1 ?? "")}
      <div class="prompt" style="top:${pct(Q2_REGION.y - 0.06)}">Part A, Question 2 (3 points): What is 6 times 7?</div>
      ${box(Q2_REGION, "", filled?.q2 ?? "")}
    </body></html>`);
  return await page.screenshot({ type: "png" });
}

/** Kick the exam worker (drains the queue) the way the cron/RPC would. */
async function runExamWorker(): Promise<void> {
  await fetch(`${FUNCTIONS_URL}/functions/v1/exam-async-worker`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-edge-function-secret": EDGE_SECRET },
    body: "{}"
  }).catch(() => {
    // best-effort; the caller polls the DB for the result
  });
}

/**
 * Drive the worker until the batch reaches `status`. Fails immediately, with the provider's
 * error, if anything for this class lands in the DLQ: a bad key or a retired model is a
 * deterministic failure, and waiting out the timeout would only hide the reason.
 */
async function waitForBatch(classId: number, batchId: number, status: string, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    await runExamWorker();
    const { data: dlq } = await supabase
      .from("exam_async_worker_dlq_messages")
      .select("method, error_type, error_message")
      .eq("class_id", classId);
    if (dlq && dlq.length > 0) {
      throw new Error(`exam worker dead-lettered ${dlq.length} message(s): ${JSON.stringify(dlq, null, 2)}`);
    }
    const { data } = await supabase.from("exam_scan_batches").select("status").eq("id", batchId).single();
    last = data?.status;
    if (last === status) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`batch ${batchId} did not reach '${status}' within ${timeoutMs}ms (last status: ${last})`);
}

test.describe("Exam OCR with Google Vision + Gemini", () => {
  test.beforeAll(() => {
    // The provider is configured in the edge runtime, not here; this only fails the run early
    // and legibly when the workflow forgot to pass the key through.
    expect(
      process.env.EXAM_VISION_PROVIDER,
      "EXAM_VISION_PROVIDER must be 'gemini' for the vision suite (see exam-vision-e2e.yml)"
    ).toBe("gemini");
  });

  test("scans are OCR'd, matched to students by SIS id and name, and finalized", async ({ page }) => {
    const course = await createClass({ name: "Exam Vision E2E" });
    await createUserInClass({ role: "instructor", class_id: course.id });
    const alice = await createUserInClass({ role: "student", class_id: course.id, name: "Alice Smith" });
    const bob = await createUserInClass({ role: "student", class_id: course.id, name: "Bob Jones" });
    // users.sis_user_id is globally unique; derive per-run ids from the fresh class id (as in
    // exam-grading.spec.ts) so re-runs against a persistent DB don't collide.
    const sisBase = 1_000_000 + ((course.id * 10) % 1_000_000_000);
    const aliceSis = sisBase + 1;
    const bobSis = sisBase + 2;
    const unknownSis = sisBase + 9;
    await setUserSisId(alice.user_id, aliceSis);
    await setUserSisId(bob.user_id, bobSis);

    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Midterm Exam (vision)",
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
        { client_id: "p1", parent_client_id: null, level: 1, ordinal: 0, label: "Part A" },
        {
          client_id: "q1",
          parent_client_id: "p1",
          level: 2,
          ordinal: 0,
          label: "Q1",
          answer_type: "free_text",
          points: 5
        },
        // numeric, so finalize also exercises Gemini's structureAnswer (free_text skips it)
        {
          client_id: "q2",
          parent_client_id: "p1",
          level: 2,
          ordinal: 1,
          label: "Q2",
          answer_type: "numeric",
          points: 3
        }
      ],
      p_regions: [
        { question_client_id: "q1", kind: "answer", page_number: 1, ...Q1_REGION },
        { question_client_id: "q2", kind: "answer", page_number: 1, ...Q2_REGION },
        { question_client_id: null, kind: "student_id", page_number: 1, ...SIS_REGION },
        { question_client_id: null, kind: "name", page_number: 1, ...NAME_REGION }
      ]
    });
    expect(structErr).toBeNull();

    const { error: syncErr } = await supabase.rpc("exam_sync_rubric_from_questions", {
      p_exam_id: examId as number,
      p_rubric_id: assignment.grading_rubric_id as number
    });
    expect(syncErr).toBeNull();

    const scans: (Filled & { profileId: string | null })[] = [
      {
        sis: String(aliceSis),
        name: "Alice Smith",
        q1: "Observer pattern",
        q2: "42",
        profileId: alice.private_profile_id
      },
      { sis: String(bobSis), name: "Bob Jones", q1: "Observer", q2: "42", profileId: bob.private_profile_id },
      { sis: String(unknownSis), name: "Nobody Here", q1: "Singleton", q2: "13", profileId: null }
    ];

    const { data: batch, error: batchErr } = await supabase
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
    expect(batchErr).toBeNull();
    const batchId = batch!.id;

    for (let i = 0; i < scans.length; i++) {
      const png = await renderExamPage(page, scans[i]);
      // A neutral object name: the fake provider reads identity from the path, and the real
      // one must not get the chance to.
      const path = `classes/${course.id}/exams/${examId}/batches/${batchId}/page-${i}.png`;
      const up = await supabase.storage
        .from("exam-scans")
        .upload(path, png, { contentType: "image/png", upsert: true });
      expect(up.error).toBeNull();
      const { error: pageErr } = await supabase.from("exam_scan_pages").insert({
        class_id: course.id,
        exam_id: examId as number,
        batch_id: batchId,
        page_index: i,
        image_path: path,
        width: PAGE_W,
        height: PAGE_H
      });
      expect(pageErr).toBeNull();
    }

    // --- OCR + identity + match ---
    const { error: procErr } = await supabase.rpc("enqueue_exam_process_batch", { p_batch_id: batchId });
    expect(procErr).toBeNull();
    await waitForBatch(course.id, batchId, "review");

    const { data: pages } = await supabase
      .from("exam_scan_pages")
      .select("page_index, ocr_text, ocr_data")
      .eq("batch_id", batchId)
      .order("page_index");
    expect(pages).toHaveLength(scans.length);
    for (const p of pages ?? []) {
      const scan = scans[p.page_index];
      // Vision read the page, and returned word boxes for region cropping
      expect(p.ocr_text ?? "").toContain(scan.sis);
      expect(p.ocr_text ?? "").toMatch(/Midterm/i);
      const words = (p.ocr_data as { words?: unknown[] } | null)?.words ?? [];
      expect(words.length).toBeGreaterThan(10);
    }

    const { data: scanned } = await supabase
      .from("exam_scanned_submissions")
      .select("id, detected_sis_id, detected_name, matched_profile_id, match_status, match_confidence")
      .eq("batch_id", batchId)
      .order("exam_index");
    expect(scanned).toHaveLength(scans.length);
    for (let i = 0; i < scans.length; i++) {
      const s = scanned![i];
      const want = scans[i];
      // Gemini read the identity regions
      expect(s.detected_sis_id?.replace(/\D/g, "")).toBe(want.sis);
      expect((s.detected_name ?? "").toLowerCase()).toContain(want.name.split(" ")[1].toLowerCase());
      if (want.profileId) {
        expect(s.matched_profile_id).toBe(want.profileId);
        expect(s.match_status).toBe("suggested");
        // SIS id and name agree
        expect(s.match_confidence).toBe(1);
      } else {
        expect(s.matched_profile_id).toBeNull();
        expect(s.match_status).toBe("unmatched");
      }
    }

    // --- confirm + finalize ---
    await supabase
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", batchId)
      .not("matched_profile_id", "is", null);
    const { error: finErr } = await supabase.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
    expect(finErr).toBeNull();
    await waitForBatch(course.id, batchId, "completed");

    const { data: questions } = await supabase
      .from("exam_questions")
      .select("id, label")
      .eq("exam_id", examId as number);
    const q1Id = questions!.find((q) => q.label === "Q1")!.id;
    const q2Id = questions!.find((q) => q.label === "Q2")!.id;

    for (const want of scans.filter((s) => s.profileId)) {
      const { data: sub } = await supabase
        .from("submissions")
        .select("id")
        .eq("assignment_id", assignment.id)
        .eq("profile_id", want.profileId!)
        .single();
      expect(sub).toBeTruthy();
      const { data: artifacts } = await supabase
        .from("submission_artifacts")
        .select("data")
        .eq("submission_id", sub!.id);
      const exam = (artifacts ?? []).find((a) => (a.data as { format?: string } | null)?.format === "exam_v1");
      expect(exam).toBeTruthy();
      const answers = (
        exam!.data as {
          questions: { exam_question_id: number; ocr_text: string; structured_value: unknown }[];
        }
      ).questions;
      const a1 = answers.find((a) => a.exam_question_id === q1Id);
      const a2 = answers.find((a) => a.exam_question_id === q2Id);
      // The region crop holds the answer and not the prompt above it
      expect(a1?.ocr_text ?? "").toMatch(/observer/i);
      expect(a1?.ocr_text ?? "").not.toMatch(/design pattern/i);
      expect(a2?.ocr_text ?? "").toContain("42");
      expect(String(a2?.structured_value)).toContain("42");
    }
  });

  test("template extraction proposes questions and identity regions", async ({ page }) => {
    const course = await createClass({ name: "Exam Vision Template E2E" });
    const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Midterm Template (vision)",
      assignment_type: "exam",
      due_date: addDays(new Date(), 7).toISOString()
    });
    const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
      p_assignment_id: assignment.id,
      p_source_type: "pdf",
      p_num_pages: 1
    });
    expect(examErr).toBeNull();

    const png = await renderExamPage(page);
    const path = `classes/${course.id}/exams/${examId}/template/page-1.png`;
    const up = await supabase.storage
      .from("exam-templates")
      .upload(path, png, { contentType: "image/png", upsert: true });
    expect(up.error).toBeNull();
    const { error: tplErr } = await supabase.from("exam_template_pages").insert({
      class_id: course.id,
      exam_id: examId as number,
      page_number: 1,
      image_path: path,
      width: PAGE_W,
      height: PAGE_H
    });
    expect(tplErr).toBeNull();

    const token = await getAuthTokenForUser(instructor);
    const res = await fetch(`${FUNCTIONS_URL}/functions/v1/exam-extract-template`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ exam_id: examId })
    });
    const body = await res.text();
    expect(res.status, body).toBe(200);
    const tree = JSON.parse(body) as {
      questions?: { level: number; label?: string }[];
      regions?: { kind: string; x: number; y: number; width: number; height: number }[];
    };

    // parseJson falls back to an empty tree on unparseable model output, so "no questions" is
    // the signature of a broken prompt or model, not a quiet page.
    expect(tree.questions?.length ?? 0, body).toBeGreaterThanOrEqual(2);
    const kinds = new Set((tree.regions ?? []).map((r) => r.kind));
    expect(kinds.has("student_id") || kinds.has("name"), body).toBe(true);
    expect(kinds.has("answer"), body).toBe(true);
    for (const r of tree.regions ?? []) {
      // normalized, per the prompt's contract
      for (const v of [r.x, r.y, r.width, r.height]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
