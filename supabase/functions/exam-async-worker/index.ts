import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import type { Json } from "../_shared/SupabaseTypes.d.ts";
import type { ExamAsyncEnvelope, FinalizeArgs, MatchArgs, ProcessPageArgs } from "../_shared/ExamAsyncTypes.ts";
import {
  getExamVisionProvider,
  ProviderRateLimitError,
  wordsInRegion,
  type NormRect,
  type PageImage,
  type WordBox
} from "../_shared/examVision.ts";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const QUEUE = "exam_processing";
const DLQ = "exam_processing_dlq";
const PGMQ_MAX_READ_CT = 8;

type QueueMessage = {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  message: ExamAsyncEnvelope;
};

type Admin = SupabaseClient<Database>;

async function archive(admin: Admin, msgId: number): Promise<void> {
  await admin.schema("pgmq_public").rpc("archive", { queue_name: QUEUE, message_id: msgId });
}

async function requeue(admin: Admin, env: ExamAsyncEnvelope, delaySeconds: number): Promise<void> {
  const next: ExamAsyncEnvelope = { ...env, retry_count: (env.retry_count ?? 0) + 1 };
  await admin.schema("pgmq_public").rpc("send", {
    queue_name: QUEUE,
    message: next as unknown as Json,
    sleep_seconds: delaySeconds
  });
}

async function deadLetter(admin: Admin, env: ExamAsyncEnvelope, msgId: number, error: unknown): Promise<void> {
  await admin.schema("pgmq_public").rpc("send", { queue_name: DLQ, message: env as unknown as Json, sleep_seconds: 0 });
  await admin.from("exam_async_worker_dlq_messages").insert({
    original_msg_id: msgId,
    method: env.method,
    envelope: env as unknown as Json,
    error_message: error instanceof Error ? error.message : String(error),
    error_type: error instanceof Error ? error.constructor.name : "Unknown",
    retry_count: env.retry_count ?? 0,
    class_id: env.class_id,
    debug_id: env.debug_id ?? null
  });
}

async function setBatchError(admin: Admin, batchId: number, message: string): Promise<void> {
  await admin.from("exam_scan_batches").update({ status: "error", error: message }).eq("id", batchId);
}

async function downloadImage(admin: Admin, bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`download ${bucket}/${path} failed: ${error?.message}`);
  return new Uint8Array(await data.arrayBuffer());
}

// ---------------------------------------------------------------------------
// process_page: OCR one scan page
// ---------------------------------------------------------------------------
async function processPage(admin: Admin, args: ProcessPageArgs): Promise<void> {
  const provider = getExamVisionProvider();
  const { data: page, error } = await admin
    .from("exam_scan_pages")
    .select("id, image_path, width, height, ocr_text")
    .eq("id", args.scan_page_id)
    .single();
  if (error || !page) throw new Error(`scan page ${args.scan_page_id} not found`);
  if (page.ocr_text) return; // idempotent — already OCR'd

  const bytes = await downloadImage(admin, "exam-scans", page.image_path);
  const img: PageImage = {
    name: page.image_path,
    bytes,
    width: page.width ?? 0,
    height: page.height ?? 0
  };
  const result = await provider.ocrImage(img);
  await admin
    .from("exam_scan_pages")
    .update({ ocr_text: result.text, ocr_data: { words: result.words } as unknown as Json })
    .eq("id", args.scan_page_id);
}

// ---------------------------------------------------------------------------
// match: group pages into per-student exams, read identity, suggest a match
// ---------------------------------------------------------------------------
type RosterEntry = { profile_id: string; name: string | null };

async function loadRoster(admin: Admin, classId: number): Promise<RosterEntry[]> {
  const { data } = await admin
    .from("user_roles")
    .select("private_profile_id, profiles!user_roles_private_profile_id_fkey(name)")
    .eq("class_id", classId)
    .eq("role", "student");
  return (data ?? [])
    .filter((r) => r.private_profile_id)
    .map((r) => ({
      profile_id: r.private_profile_id as string,
      name: (r.profiles as unknown as { name: string | null } | null)?.name ?? null
    }));
}

async function matchProfile(
  admin: Admin,
  classId: number,
  detectedSisId: string | undefined,
  detectedName: string | undefined,
  roster: RosterEntry[]
): Promise<{ profile_id: string | null; confidence: number }> {
  // 1) exact SIS id (users.sis_user_id integer) -> private_profile_id
  if (detectedSisId && /^\d+$/.test(detectedSisId)) {
    const { data: user } = await admin
      .from("users")
      .select("user_id")
      .eq("sis_user_id", parseInt(detectedSisId, 10))
      .maybeSingle();
    if (user?.user_id) {
      const { data: ur } = await admin
        .from("user_roles")
        .select("private_profile_id")
        .eq("class_id", classId)
        .eq("role", "student")
        .eq("user_id", user.user_id)
        .maybeSingle();
      if (ur?.private_profile_id) return { profile_id: ur.private_profile_id, confidence: 1 };
    }
  }
  // 2) case-insensitive exact name
  if (detectedName) {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const want = norm(detectedName);
    const hit = roster.find((r) => r.name && norm(r.name) === want);
    if (hit) return { profile_id: hit.profile_id, confidence: 0.6 };
  }
  return { profile_id: null, confidence: 0 };
}

async function doMatch(admin: Admin, classId: number, args: MatchArgs): Promise<void> {
  const provider = getExamVisionProvider();
  const { data: batch, error } = await admin
    .from("exam_scan_batches")
    .select("id, exam_id, pages_per_exam")
    .eq("id", args.batch_id)
    .single();
  if (error || !batch) throw new Error(`batch ${args.batch_id} not found`);
  await admin.from("exam_scan_batches").update({ status: "matching" }).eq("id", batch.id);

  const perExam = Math.max(1, batch.pages_per_exam);
  const { data: pages } = await admin
    .from("exam_scan_pages")
    .select("id, page_index, image_path, width, height")
    .eq("batch_id", batch.id)
    .order("page_index", { ascending: true });
  if (!pages || pages.length === 0) {
    await admin.from("exam_scan_batches").update({ status: "review" }).eq("id", batch.id);
    return;
  }

  // identity region (kind name/student_id) defined on the template
  const { data: idRegions } = await admin
    .from("exam_question_regions")
    .select("kind, page_number, x, y, width, height")
    .eq("exam_id", batch.exam_id)
    .in("kind", ["student_id", "name"]);
  const idRegion = (idRegions ?? [])[0] as (NormRect & { kind: string; page_number: number }) | undefined;

  const roster = await loadRoster(admin, classId);
  const groupCount = Math.ceil(pages.length / perExam);

  for (let g = 0; g < groupCount; g++) {
    const groupPages = pages.slice(g * perExam, g * perExam + perExam);
    // upsert the scanned submission for this group
    let scannedId: number;
    const { data: existing } = await admin
      .from("exam_scanned_submissions")
      .select("id")
      .eq("batch_id", batch.id)
      .eq("exam_index", g)
      .maybeSingle();
    if (existing?.id) {
      scannedId = existing.id;
    } else {
      const { data: created, error: cErr } = await admin
        .from("exam_scanned_submissions")
        .insert({ class_id: classId, exam_id: batch.exam_id, batch_id: batch.id, exam_index: g })
        .select("id")
        .single();
      if (cErr || !created) throw new Error(`create scanned submission failed: ${cErr?.message}`);
      scannedId = created.id;
    }
    await admin
      .from("exam_scan_pages")
      .update({ scanned_submission_id: scannedId })
      .in(
        "id",
        groupPages.map((p) => p.id)
      );

    // read identity from the page that holds the identity region (default: first page)
    const idPageNumber = idRegion?.page_number ?? 1;
    const idPage = groupPages[Math.min(idPageNumber - 1, groupPages.length - 1)] ?? groupPages[0];
    const bytes = await downloadImage(admin, "exam-scans", idPage.image_path);
    const img: PageImage = { name: idPage.image_path, bytes, width: idPage.width ?? 0, height: idPage.height ?? 0 };
    const region: NormRect | null = idRegion
      ? { x: idRegion.x, y: idRegion.y, width: idRegion.width, height: idRegion.height }
      : null;
    const identity = await provider.readIdentity(img, region);
    const match = await matchProfile(admin, classId, identity.sisId, identity.name, roster);

    await admin
      .from("exam_scanned_submissions")
      .update({
        detected_name: identity.name ?? null,
        detected_sis_id: identity.sisId ?? null,
        matched_profile_id: match.profile_id,
        match_confidence: match.confidence,
        match_status: match.profile_id ? "suggested" : "unmatched"
      })
      .eq("id", scannedId);
  }

  await admin.from("exam_scan_batches").update({ status: "review" }).eq("id", batch.id);
}

// ---------------------------------------------------------------------------
// finalize: create the submission, copy raw pages, assemble the exam_v1 artifact
// ---------------------------------------------------------------------------
async function finalize(admin: Admin, classId: number, args: FinalizeArgs): Promise<void> {
  const provider = getExamVisionProvider();
  const { data: scanned, error } = await admin
    .from("exam_scanned_submissions")
    .select("id, exam_id, batch_id, matched_profile_id, match_status, submission_id")
    .eq("id", args.scanned_submission_id)
    .single();
  if (error || !scanned) throw new Error(`scanned submission ${args.scanned_submission_id} not found`);
  if (scanned.submission_id) return; // already finalized
  if (scanned.match_status !== "confirmed" || !scanned.matched_profile_id) {
    throw new Error(`scanned submission ${scanned.id} is not a confirmed match`);
  }
  const profileId = scanned.matched_profile_id as string;

  // create the submission (fires submissions_after_insert_hook -> grading review)
  const { data: subId, error: rpcErr } = await admin.rpc("exam_create_submission", {
    p_scanned_submission_id: scanned.id
  });
  if (rpcErr || !subId) throw new Error(`exam_create_submission failed: ${rpcErr?.message}`);
  const submissionId = subId as number;

  const { data: batch } = await admin
    .from("exam_scan_batches")
    .select("pages_per_exam")
    .eq("id", scanned.batch_id)
    .single();
  const perExam = Math.max(1, batch?.pages_per_exam ?? 1);

  const { data: pages } = await admin
    .from("exam_scan_pages")
    .select("id, page_index, image_path, width, height, ocr_data")
    .eq("scanned_submission_id", scanned.id)
    .order("page_index", { ascending: true });
  const groupPages = pages ?? [];

  // copy each raw page into submission-files and record a submission_files row
  const pageRefs: { page_number: number; storage_key: string; width: number; height: number }[] = [];
  for (let i = 0; i < groupPages.length; i++) {
    const p = groupPages[i];
    const bytes = await downloadImage(admin, "exam-scans", p.image_path);
    const storageKey = `classes/${classId}/profiles/${profileId}/submissions/${submissionId}/files/exam-page-${i + 1}.png`;
    const up = await admin.storage.from("submission-files").upload(storageKey, bytes, {
      contentType: "image/png",
      upsert: true
    });
    if (up.error) throw new Error(`upload ${storageKey} failed: ${up.error.message}`);
    await admin.from("submission_files").insert({
      submission_id: submissionId,
      name: `exam-page-${i + 1}.png`,
      class_id: classId,
      profile_id: profileId,
      is_binary: true,
      mime_type: "image/png",
      file_size: bytes.length,
      storage_key: storageKey,
      contents: null
    });
    pageRefs.push({ page_number: i + 1, storage_key: storageKey, width: p.width ?? 0, height: p.height ?? 0 });
  }

  // answer questions: for each answer region, OCR text from the right page's words ∩ region
  const { data: regions } = await admin
    .from("exam_question_regions")
    .select("exam_question_id, page_number, x, y, width, height, exam_questions(answer_type)")
    .eq("exam_id", scanned.exam_id)
    .eq("kind", "answer")
    .not("exam_question_id", "is", null);

  const questions: unknown[] = [];
  for (const r of regions ?? []) {
    const examPageNo = Math.min(Math.max(1, r.page_number), perExam);
    const page = groupPages[examPageNo - 1];
    if (!page) continue;
    const words = ((page.ocr_data as { words?: WordBox[] } | null)?.words ?? []) as WordBox[];
    const rect: NormRect = { x: r.x, y: r.y, width: r.width, height: r.height };
    const ocrText = wordsInRegion(words, rect);
    let structuredValue: unknown = ocrText;
    const answerType = (r.exam_questions as unknown as { answer_type: string | null } | null)?.answer_type ?? null;
    if (answerType && answerType !== "free_text" && ocrText) {
      try {
        const bytes = await downloadImage(admin, "exam-scans", page.image_path);
        const img: PageImage = { name: page.image_path, bytes, width: page.width ?? 0, height: page.height ?? 0 };
        const structured = await provider.structureAnswer(answerType, img, rect, ocrText);
        structuredValue = structured.value;
      } catch (_e) {
        // fall back to raw OCR text on structuring failure
      }
    }
    questions.push({
      exam_question_id: r.exam_question_id,
      page_number: examPageNo,
      region: rect,
      ocr_text: ocrText,
      structured_value: structuredValue
    });
  }

  await admin.from("submission_artifacts").insert({
    submission_id: submissionId,
    class_id: classId,
    profile_id: profileId,
    name: "Exam",
    data: { format: "exam_v1", pages: pageRefs, questions } as unknown as Json
  });

  // mark the batch completed once no confirmed submissions remain unfinalized
  const { count } = await admin
    .from("exam_scanned_submissions")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", scanned.batch_id)
    .eq("match_status", "confirmed")
    .is("submission_id", null);
  if ((count ?? 0) === 0) {
    await admin.from("exam_scan_batches").update({ status: "completed" }).eq("id", scanned.batch_id);
  }
}

// ---------------------------------------------------------------------------
// Dispatch one message
// ---------------------------------------------------------------------------
async function processMessage(admin: Admin, msg: QueueMessage, scope: Sentry.Scope): Promise<void> {
  const env = msg.message;
  scope.setTag("exam_method", env.method);
  scope.setTag("batch_id", String(env.batch_id));

  // poison-pill protection
  if (msg.read_ct >= PGMQ_MAX_READ_CT) {
    const err = new Error(`read_ct=${msg.read_ct} exceeded max — DLQ`);
    Sentry.captureException(err, scope);
    await deadLetter(admin, env, msg.msg_id, err);
    if (env.batch_id) await setBatchError(admin, env.batch_id, err.message);
    await archive(admin, msg.msg_id);
    return;
  }

  try {
    if (env.method === "process_page") {
      await processPage(admin, env.args as ProcessPageArgs);
    } else if (env.method === "match") {
      await doMatch(admin, env.class_id, env.args as MatchArgs);
    } else if (env.method === "finalize") {
      await finalize(admin, env.class_id, env.args as FinalizeArgs);
    } else {
      throw new Error(`unknown method ${(env as { method: string }).method}`);
    }
    await archive(admin, msg.msg_id);
  } catch (error) {
    if (error instanceof ProviderRateLimitError) {
      // requeue this message with the provider's backoff; archive the current copy
      await requeue(admin, env, error.retryAfterSeconds);
      await archive(admin, msg.msg_id);
      return;
    }
    const retryCount = env.retry_count ?? 0;
    if (retryCount >= 5) {
      Sentry.captureException(error, scope);
      await deadLetter(admin, env, msg.msg_id, error);
      if (env.batch_id)
        await setBatchError(admin, env.batch_id, error instanceof Error ? error.message : String(error));
      await archive(admin, msg.msg_id);
      return;
    }
    // transient: requeue with exponential backoff
    Sentry.captureException(error, scope);
    const delay = Math.min(300, 10 * Math.pow(2, retryCount));
    await requeue(admin, env, delay);
    await archive(admin, msg.msg_id);
  }
}

async function runBatch(): Promise<number> {
  const scope = new Sentry.Scope();
  scope.setTag("function", "exam-async-worker");
  const admin = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let processed = 0;
  for (let pass = 0; pass < 50; pass++) {
    const { data, error } = await admin.schema("pgmq_public").rpc("read", {
      queue_name: QUEUE,
      sleep_seconds: 120,
      n: 5
    });
    if (error) {
      Sentry.captureException(error, scope);
      break;
    }
    const messages = (data ?? []) as QueueMessage[];
    if (messages.length === 0) break;
    for (const msg of messages) {
      await processMessage(admin, msg, scope.clone());
      processed++;
    }
  }
  return processed;
}

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    environment: Deno.env.get("ENVIRONMENT") || "development",
    integrations: [],
    tracesSampleRate: 0
  });
}

Deno.serve((req) => {
  const secret = req.headers.get("x-edge-function-secret");
  const expected = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";
  if (secret !== expected) {
    return new Response(JSON.stringify({ error: "Invalid secret" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  EdgeRuntime.waitUntil(runBatch());
  return Promise.resolve(
    new Response(JSON.stringify({ message: "exam-async-worker started" }), {
      headers: { "Content-Type": "application/json" }
    })
  );
});
