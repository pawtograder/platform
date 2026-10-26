import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import http from "node:http";
import type { Socket } from "node:net";
import { createClass, createUserInClass, insertAssignment, supabase } from "./TestingUtils";

/**
 * #1077: a temporary Gemini failure while finalize structures an answer must be retried, not
 * finalized with the raw OCR text.
 *
 * This drives the real exam-async-worker and the real Gemini adapter against a local stand-in
 * for the Gemini API that fails on cue (503, connection reset, a hang past the 60s timeout, 429,
 * malformed output). It needs the functions served with
 *   EXAM_VISION_PROVIDER=gemini  GOOGLE_API_KEY=<any dummy>  EXAM_GEMINI_RPM=0
 *   EXAM_GEMINI_BASE_URL=http://host.docker.internal:<port>
 * and the same <port> in EXAM_FAULT_PROVIDER_PORT for this run. It skips otherwise: the per-PR
 * e2e lane serves the `fake` provider, which never calls Gemini.
 *
 * Scan pages are arranged with stored OCR words, so the only provider call is structuring.
 */

const FAULT_PORT = process.env.EXAM_FAULT_PROVIDER_PORT;
const FUNCTIONS_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const EDGE_SECRET = process.env.EDGE_FUNCTION_SECRET ?? "some-secret-value";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const ANSWER_REGION = { x: 0.1, y: 0.3, width: 0.8, height: 0.2 };

type Reply = "ok" | "503" | "reset" | "hang" | "429" | "malformed";
type StandInRequest = { answer: string; reply: Reply; apiKey: string | undefined };

/** Local stand-in for Gemini's generateContent; replies are taken from `script`, then "ok". */
class GeminiStandIn {
  script: Reply[] = [];
  requests: StandInRequest[] = [];
  /** Failing replies the worker has actually received (sent, reset, or abandoned by the client). */
  failuresDelivered = 0;
  private sockets = new Set<Socket>();
  private server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // The prompt is the first text part of the JSON request; it quotes the region's OCR text.
      const prompt: string =
        (JSON.parse(body) as { contents?: { parts?: { text?: string }[] }[] }).contents?.[0]?.parts?.[0]?.text ?? "";
      const quoted = /OCR text of the region: ("(?:[^"\\]|\\.)*")/.exec(prompt)?.[1];
      const answer = quoted ? (JSON.parse(quoted) as string) : "";
      const reply = this.script.shift() ?? "ok";
      const apiKey = req.headers["x-goog-api-key"];
      this.requests.push({ answer, reply, apiKey: typeof apiKey === "string" ? apiKey : undefined });
      const gemini = (text: string) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
      const send = (status: number, payload: string) => {
        res.on("finish", () => {
          if (status !== 200) this.failuresDelivered++;
        });
        res.writeHead(status, { "Content-Type": "application/json" }).end(payload);
      };
      if (reply === "ok") send(200, gemini(JSON.stringify({ value: Number(answer), text: answer })));
      else if (reply === "malformed") send(200, gemini("I could not read that, sorry"));
      // The 503 body reflects the request's key, as a misbehaving upstream or proxy error page
      // might; nothing from it may reach the worker's persisted diagnostics.
      else if (reply === "503")
        send(503, JSON.stringify({ error: { code: 503, status: "UNAVAILABLE" }, echo: apiKey }));
      else if (reply === "429") send(429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');
      else if (reply === "reset") {
        this.failuresDelivered++;
        req.socket.destroy();
      } else {
        // hang: never answer; the worker's 60s timeout abandons the connection
        req.socket.on("close", () => this.failuresDelivered++);
      }
    });
  });

  constructor() {
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }
  listen(port: number) {
    return new Promise<void>((resolve) => this.server.listen(port, "0.0.0.0", resolve));
  }
  reset(script: Reply[]) {
    this.script = script;
    this.requests = [];
    this.failuresDelivered = 0;
  }
  close() {
    for (const s of this.sockets) s.destroy();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

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

type Fixture = {
  classId: number;
  assignmentId: number;
  batchId: number;
  scanned: { id: number; answer: string }[];
};

/** A batch in review whose scans (one page each, OCR already stored) are confirmed matches. */
async function arrangeConfirmedNumericExam(answers: string[]): Promise<Fixture> {
  const course = await createClass({ name: "Exam provider faults E2E" });
  await createUserInClass({ role: "instructor", class_id: course.id });
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
      { client_id: "p1", parent_client_id: null, level: 1, ordinal: 0, label: "Part A" },
      { client_id: "q1", parent_client_id: "p1", level: 2, ordinal: 0, label: "Q1" },
      {
        client_id: "c1",
        parent_client_id: "q1",
        level: 3,
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
    .insert({
      class_id: course.id,
      exam_id: examId as number,
      total_pages: answers.length,
      pages_per_exam: 1,
      status: "review"
    })
    .select("id")
    .single();
  expect(batchErr).toBeNull();

  const scanned: Fixture["scanned"] = [];
  for (let i = 0; i < answers.length; i++) {
    const student = await createUserInClass({ role: "student", class_id: course.id });
    const path = `classes/${course.id}/exams/${examId}/batches/${batch!.id}/page-${i}.png`;
    const up = await supabase.storage
      .from("exam-scans")
      .upload(path, PNG_1x1, { contentType: "image/png", upsert: true });
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
    // One OCR word whose centre lies inside the answer region.
    const { error: pageErr } = await supabase.from("exam_scan_pages").insert({
      class_id: course.id,
      exam_id: examId as number,
      batch_id: batch!.id,
      page_index: i,
      image_path: path,
      width: 1000,
      height: 1400,
      ocr_text: answers[i],
      ocr_data: { words: [{ text: answers[i], x: 0.4, y: 0.35, width: 0.1, height: 0.05 }] },
      scanned_submission_id: row!.id
    });
    expect(pageErr).toBeNull();
    scanned.push({ id: row!.id, answer: answers[i] });
  }
  return { classId: course.id, assignmentId: assignment.id, batchId: batch!.id, scanned };
}

async function batchState(fx: Fixture) {
  const { data: batch } = await supabase
    .from("exam_scan_batches")
    .select("status, error")
    .eq("id", fx.batchId)
    .single();
  const { data: rows } = await supabase
    .from("exam_scanned_submissions")
    .select("id, finalized_at, submission_id")
    .in(
      "id",
      fx.scanned.map((s) => s.id)
    );
  const { data: dlq } = await supabase
    .from("exam_async_worker_dlq_messages")
    .select("method, error_type, error_message")
    .eq("class_id", fx.classId);
  return { batch: batch!, rows: rows ?? [], dlq: dlq ?? [] };
}

async function pollBatchStatus(fx: Fixture, status: string, timeout: number) {
  await expect
    .poll(
      async () => {
        await runExamWorker();
        return (await batchState(fx)).batch.status;
      },
      { timeout, intervals: [2000, 3000, 5000] }
    )
    .toBe(status);
}

/** Exactly one submission, one page file and one exam_v1 artifact per student; returns structured values. */
async function finalizedAnswers(fx: Fixture): Promise<Map<string, unknown>> {
  const { data: submissions } = await supabase.from("submissions").select("id").eq("assignment_id", fx.assignmentId);
  expect(submissions ?? []).toHaveLength(fx.scanned.length);
  const { rows } = await batchState(fx);
  const values = new Map<string, unknown>();
  for (const s of fx.scanned) {
    const row = rows.find((r) => r.id === s.id)!;
    expect(row.finalized_at).not.toBeNull();
    expect((submissions ?? []).map((x) => x.id)).toContain(row.submission_id);
    const { data: files } = await supabase
      .from("submission_files")
      .select("id")
      .eq("submission_id", row.submission_id!);
    expect(files ?? []).toHaveLength(1);
    const { data: artifacts } = await supabase
      .from("submission_artifacts")
      .select("data")
      .eq("submission_id", row.submission_id!);
    const exam = (artifacts ?? []).filter((a) => (a.data as { format?: string } | null)?.format === "exam_v1");
    expect(exam).toHaveLength(1);
    const questions = (exam[0].data as { questions: { structured_value: unknown }[] }).questions;
    expect(questions).toHaveLength(1);
    values.set(s.answer, questions[0].structured_value);
  }
  return values;
}

// Booleans only: a failing `not.toContain` would print the text, and with it the credential.
function expectNoKeyIn(texts: { label: string; text: string | null | undefined }[], apiKey: string) {
  for (const { label, text } of texts)
    expect((text ?? "").includes(apiKey), `${label} contains the credential`).toBe(false);
}

test.describe("Exam finalize: Gemini provider failures (#1077)", () => {
  test.skip(!FAULT_PORT, "needs EXAM_FAULT_PROVIDER_PORT and functions served against the Gemini stand-in");

  const standIn = new GeminiStandIn();
  test.beforeAll(async () => {
    await standIn.listen(Number(FAULT_PORT));
  });
  test.afterAll(async () => {
    await standIn.close();
  });

  const transient: { reply: Reply; label: string; failFirst: number; waitForFailure: number }[] = [
    { reply: "503", label: "HTTP 503", failFirst: 2, waitForFailure: 60_000 },
    { reply: "reset", label: "a connection reset", failFirst: 2, waitForFailure: 60_000 },
    // One hang: each is held for the adapter's full 60s timeout before the worker gives up.
    { reply: "hang", label: "a request timeout", failFirst: 1, waitForFailure: 150_000 }
  ];

  for (const c of transient) {
    test(`${c.label} while structuring is retried and recovers without finalizing early`, async () => {
      test.setTimeout(c.waitForFailure + 240_000);
      standIn.reset(Array(c.failFirst).fill(c.reply));
      const fx = await arrangeConfirmedNumericExam(["42", "7"]);
      const { data: queued, error } = await supabase.rpc("enqueue_exam_finalize", { p_batch_id: fx.batchId });
      expect(error).toBeNull();
      expect(queued).toBe(2);

      // The failing replies reached the worker...
      await expect
        .poll(
          async () => {
            await runExamWorker();
            return standIn.failuresDelivered;
          },
          { timeout: c.waitForFailure, intervals: [1000, 2000] }
        )
        .toBeGreaterThanOrEqual(c.failFirst);
      // ...and a worker that swallowed them would have finalized within this settle time, while
      // the first retry is not due for 10s.
      await new Promise((r) => setTimeout(r, 3000));
      const failedAnswers = new Set(standIn.requests.filter((r) => r.reply === c.reply).map((r) => r.answer));
      expect(failedAnswers.size).toBe(c.failFirst);
      const mid = await batchState(fx);
      for (const s of fx.scanned.filter((x) => failedAnswers.has(x.answer))) {
        expect(
          mid.rows.find((r) => r.id === s.id)?.finalized_at,
          `answer ${s.answer} finalized before recovery`
        ).toBeNull();
      }
      expect(mid.batch.status).toBe("finalizing");

      // The retry recovers the structured answers.
      await pollBatchStatus(fx, "completed", 180_000);
      const values = await finalizedAnswers(fx);
      expect(values.get("42")).toBe(42);
      expect(values.get("7")).toBe(7);
      // Each failed answer was asked again and succeeded exactly once.
      for (const answer of failedAnswers) {
        expect(standIn.requests.filter((r) => r.answer === answer && r.reply === "ok")).toHaveLength(1);
      }
      const final = await batchState(fx);
      expect(final.dlq).toHaveLength(0);
      expect(final.batch.error).toBeNull();
    });
  }

  test("429 while structuring still takes the rate-limit path and recovers", async () => {
    test.setTimeout(300_000);
    standIn.reset(["429", "429"]);
    const fx = await arrangeConfirmedNumericExam(["42", "7"]);
    await supabase.rpc("enqueue_exam_finalize", { p_batch_id: fx.batchId });
    await expect
      .poll(
        async () => {
          await runExamWorker();
          return standIn.failuresDelivered;
        },
        { timeout: 60_000, intervals: [1000, 2000] }
      )
      .toBe(2);
    await new Promise((r) => setTimeout(r, 3000));
    const mid = await batchState(fx);
    expect(mid.rows.every((r) => r.finalized_at === null)).toBe(true);
    // Rate limits requeue after the provider's 60s backoff.
    await pollBatchStatus(fx, "completed", 180_000);
    const values = await finalizedAnswers(fx);
    expect(values.get("42")).toBe(42);
    expect(values.get("7")).toBe(7);
  });

  test("malformed model output keeps the raw-text fallback without retrying", async () => {
    test.setTimeout(180_000);
    standIn.reset(["malformed", "malformed"]);
    const fx = await arrangeConfirmedNumericExam(["42", "7"]);
    await supabase.rpc("enqueue_exam_finalize", { p_batch_id: fx.batchId });
    await pollBatchStatus(fx, "completed", 90_000);
    const values = await finalizedAnswers(fx);
    expect(values.get("42")).toBe("42");
    expect(values.get("7")).toBe("7");
    expect(standIn.requests).toHaveLength(2);
  });

  test("a normal reply is stored as the typed value", async () => {
    test.setTimeout(180_000);
    standIn.reset([]);
    const fx = await arrangeConfirmedNumericExam(["42", "7"]);
    await supabase.rpc("enqueue_exam_finalize", { p_batch_id: fx.batchId });
    await pollBatchStatus(fx, "completed", 90_000);
    const values = await finalizedAnswers(fx);
    expect(values.get("42")).toBe(42);
    expect(values.get("7")).toBe(7);
    expect(standIn.requests).toHaveLength(2);
  });

  test("a provider that keeps failing exhausts the retries into an error, never a false success", async () => {
    // 1 attempt + 5 retries backing off 10+20+40+80+160s.
    test.setTimeout(900_000);
    standIn.reset(Array(100).fill("503"));
    const fx = await arrangeConfirmedNumericExam(["42"]);
    await supabase.rpc("enqueue_exam_finalize", { p_batch_id: fx.batchId });
    // Wait for either terminal state, so a false success fails here rather than as a timeout.
    await expect
      .poll(
        async () => {
          await runExamWorker();
          return (await batchState(fx)).batch.status;
        },
        { timeout: 720_000, intervals: [5000] }
      )
      .toMatch(/^(error|completed)$/);
    const state = await batchState(fx);
    expect(state.batch.status).toBe("error");
    expect(state.rows[0].finalized_at).toBeNull();
    expect(state.dlq).toHaveLength(1);
    expect(state.dlq[0].method).toBe("finalize");
    expect(state.dlq[0].error_type).toBe("ProviderTransientError");
    expect(standIn.requests).toHaveLength(6);
    const { data: artifacts } = await supabase
      .from("submission_artifacts")
      .select("id")
      .eq("class_id", fx.classId)
      .eq("data->>format", "exam_v1");
    expect(artifacts ?? []).toHaveLength(0);
    const apiKey = standIn.requests[0].apiKey!;
    expect(Boolean(apiKey), "the stand-in received the key header").toBe(true);
    // Persisted diagnostics are the bounded form: provider, category and status only.
    expectNoKeyIn(
      [
        { label: "batch error", text: state.batch.error },
        ...state.dlq.map((d, i) => ({ label: `DLQ error_message[${i}]`, text: d.error_message }))
      ],
      apiKey
    );
    expect(state.batch.error).toBe("gemini request failed: category=server_error status=503");
    expect(state.dlq[0].error_message).toBe("gemini request failed: category=server_error status=503");
  });
});
