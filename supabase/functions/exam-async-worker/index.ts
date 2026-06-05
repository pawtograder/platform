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
  // Preserve the (method, args) pairing of the discriminated envelope; only bump retry_count.
  const next = { ...env, retry_count: (env.retry_count ?? 0) + 1 };
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

// Download an image at most once per cache. Lets a single doMatch group / finalize pass
// reuse the same page bytes (e.g. SIS-id and name regions on one page, or a page that is
// both copied to submission-files and read for answer structuring) instead of re-fetching.
// Caches the in-flight promise so even concurrent reads of one path share a single fetch.
function downloadImageCached(
  admin: Admin,
  cache: Map<string, Promise<Uint8Array>>,
  bucket: string,
  path: string
): Promise<Uint8Array> {
  let pending = cache.get(path);
  if (!pending) {
    pending = downloadImage(admin, bucket, path);
    cache.set(path, pending);
  }
  return pending;
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
  const { error: updErr } = await admin
    .from("exam_scan_pages")
    .update({ ocr_text: result.text, ocr_data: { words: result.words } as unknown as Json })
    .eq("id", args.scan_page_id);
  // Throw on write failure so the message is requeued, not archived (would lose the OCR).
  if (updErr) throw new Error(`persist OCR for scan page ${args.scan_page_id} failed: ${updErr.message}`);
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

async function sisIdToProfile(
  admin: Admin,
  classId: number,
  detectedSisId: string | undefined
): Promise<string | null> {
  if (!detectedSisId || !/^\d+$/.test(detectedSisId)) return null;
  const { data: user } = await admin
    .from("users")
    .select("user_id")
    .eq("sis_user_id", parseInt(detectedSisId, 10))
    .maybeSingle();
  if (!user?.user_id) return null;
  const { data: ur } = await admin
    .from("user_roles")
    .select("private_profile_id")
    .eq("class_id", classId)
    .eq("role", "student")
    .eq("user_id", user.user_id)
    .maybeSingle();
  return ur?.private_profile_id ?? null;
}

function nameToProfile(detectedName: string | undefined, roster: RosterEntry[]): string | null {
  if (!detectedName) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(detectedName);
  const hit = roster.find((r) => r.name && norm(r.name) === want);
  return hit?.profile_id ?? null;
}

// Resolve the two identity signals independently and combine them. When both an SIS id
// and a name resolve, agreement is the strongest signal (confidence 1); disagreement is
// treated as ambiguous — we trust the SIS id but flag low confidence so a grader reviews.
async function matchProfile(
  admin: Admin,
  classId: number,
  detectedSisId: string | undefined,
  detectedName: string | undefined,
  roster: RosterEntry[]
): Promise<{ profile_id: string | null; confidence: number }> {
  const sisProfile = await sisIdToProfile(admin, classId, detectedSisId);
  const nameProfile = nameToProfile(detectedName, roster);

  if (sisProfile && nameProfile) {
    return sisProfile === nameProfile
      ? { profile_id: sisProfile, confidence: 1 } // both agree
      : { profile_id: sisProfile, confidence: 0.5 }; // conflict — trust SIS id, flag for review
  }
  if (sisProfile) return { profile_id: sisProfile, confidence: 0.9 };
  if (nameProfile) return { profile_id: nameProfile, confidence: 0.6 };
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

  // identity regions (kind name/student_id) defined on the template. A template may
  // define one of each; when both exist we read each independently (they can sit on
  // different pages) and combine the two signals to disambiguate the student.
  const { data: idRegions } = await admin
    .from("exam_question_regions")
    .select("kind, page_number, x, y, width, height")
    .eq("exam_id", batch.exam_id)
    .in("kind", ["student_id", "name"]);
  type IdRegion = NormRect & { kind: string; page_number: number };
  const sisRegion = (idRegions ?? []).find((r) => r.kind === "student_id") as IdRegion | undefined;
  const nameRegion = (idRegions ?? []).find((r) => r.kind === "name") as IdRegion | undefined;

  // Read the identity within one region (or the whole first page when region is null).
  const readRegionIdentity = async (
    region: IdRegion | undefined,
    groupPages: typeof pages,
    cache: Map<string, Promise<Uint8Array>>
  ) => {
    const pageNumber = region?.page_number ?? 1;
    const page = groupPages[Math.min(pageNumber - 1, groupPages.length - 1)] ?? groupPages[0];
    const bytes = await downloadImageCached(admin, cache, "exam-scans", page.image_path);
    const img: PageImage = { name: page.image_path, bytes, width: page.width ?? 0, height: page.height ?? 0 };
    const rect: NormRect | null = region
      ? { x: region.x, y: region.y, width: region.width, height: region.height }
      : null;
    return provider.readIdentity(img, rect);
  };

  const roster = await loadRoster(admin, classId);
  const groupCount = Math.ceil(pages.length / perExam);

  for (let g = 0; g < groupCount; g++) {
    const groupPages = pages.slice(g * perExam, g * perExam + perExam);
    // upsert the scanned submission for this group
    let scannedId: number;
    let humanDecided = false;
    const { data: existing } = await admin
      .from("exam_scanned_submissions")
      .select("id, match_status")
      .eq("batch_id", batch.id)
      .eq("exam_index", g)
      .maybeSingle();
    if (existing?.id) {
      scannedId = existing.id;
      // A re-run of the match phase (re-process, or a redelivered 'match' message) must
      // never clobber a decision a human already made.
      humanDecided = existing.match_status === "confirmed" || existing.match_status === "skipped";
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

    // Preserve a human's confirmed/skipped decision across re-runs: leave the existing
    // match untouched rather than re-detecting and overwriting it.
    if (humanDecided) continue;

    // Read identity. With both an SIS-id and a name region, take the SIS id from the
    // former and the name from the latter; with one region, use just that; with none,
    // read the whole first page.
    let detectedSisId: string | undefined;
    let detectedName: string | undefined;
    // Shared per-group cache: when both identity regions are on the same page, that page
    // image is fetched once rather than once per region.
    const idImageCache = new Map<string, Promise<Uint8Array>>();
    if (sisRegion && nameRegion) {
      const [sisRes, nameRes] = await Promise.all([
        readRegionIdentity(sisRegion, groupPages, idImageCache),
        readRegionIdentity(nameRegion, groupPages, idImageCache)
      ]);
      detectedSisId = sisRes.sisId;
      detectedName = nameRes.name;
    } else {
      const res = await readRegionIdentity(sisRegion ?? nameRegion, groupPages, idImageCache);
      detectedSisId = res.sisId;
      detectedName = res.name;
    }
    const match = await matchProfile(admin, classId, detectedSisId, detectedName, roster);

    const { error: matchErr } = await admin
      .from("exam_scanned_submissions")
      .update({
        detected_name: detectedName ?? null,
        detected_sis_id: detectedSisId ?? null,
        matched_profile_id: match.profile_id,
        match_confidence: match.confidence,
        match_status: match.profile_id ? "suggested" : "unmatched"
      })
      .eq("id", scannedId);
    // Throw on write failure so the message requeues instead of being archived with the
    // match result lost.
    if (matchErr) throw new Error(`persist match for scanned submission ${scannedId} failed: ${matchErr.message}`);
  }

  const { error: reviewErr } = await admin.from("exam_scan_batches").update({ status: "review" }).eq("id", batch.id);
  if (reviewErr) throw new Error(`set batch ${batch.id} to review failed: ${reviewErr.message}`);
}

// ---------------------------------------------------------------------------
// finalize: create the submission, copy raw pages, assemble the exam_v1 artifact
// ---------------------------------------------------------------------------
// exam_scanned_submissions.finalized_at is the single source of truth for "fully
// finalized": set at the very end of finalize, after the submission row, page files, and
// exam artifact are all written. The exam_v1 format tag still marks the artifact's data
// and backs the partial unique index.
const EXAM_ARTIFACT_FORMAT = "exam_v1";

// Complete the batch once no confirmed scanned submission is still unfinalized. Re-checked
// on every finalize (including retries of already-done work) so a crash in the last step
// can't leave the batch stuck in "finalizing".
async function maybeCompleteBatch(admin: Admin, batchId: number): Promise<void> {
  const { count: confirmedCount } = await admin
    .from("exam_scanned_submissions")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("match_status", "confirmed");
  if ((confirmedCount ?? 0) === 0) return;
  const { count: pending } = await admin
    .from("exam_scanned_submissions")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("match_status", "confirmed")
    .is("finalized_at", null);
  if ((pending ?? 0) === 0) {
    await admin.from("exam_scan_batches").update({ status: "completed" }).eq("id", batchId);
  }
}

async function finalize(admin: Admin, classId: number, args: FinalizeArgs): Promise<void> {
  const provider = getExamVisionProvider();
  const { data: scanned, error } = await admin
    .from("exam_scanned_submissions")
    .select("id, exam_id, batch_id, matched_profile_id, match_status, submission_id, finalized_at")
    .eq("id", args.scanned_submission_id)
    .single();
  if (error || !scanned) throw new Error(`scanned submission ${args.scanned_submission_id} not found`);

  // Already finalized -> idempotent no-op, regardless of the current match_status (a
  // confirmation may have been changed after this message was enqueued). Still re-check
  // batch completion so a crash in that last step can't strand the batch.
  if (scanned.finalized_at) {
    await maybeCompleteBatch(admin, scanned.batch_id);
    return;
  }

  // Not (or no longer) a confirmed match -> idempotent skip, not an error. enqueue_exam_finalize
  // only queues confirmed submissions, so reaching here means the decision changed after the
  // message was enqueued; throwing would needlessly DLQ the message and error the batch.
  if (scanned.match_status !== "confirmed" || !scanned.matched_profile_id) {
    return;
  }
  const profileId = scanned.matched_profile_id as string;

  // Create the submission (fires submissions_after_insert_hook -> grading review).
  // exam_create_submission is idempotent: it returns the existing submission_id if the
  // row already exists, so a retried finalize reuses the same submission.
  const { data: subId, error: rpcErr } = await admin.rpc("exam_create_submission", {
    p_scanned_submission_id: scanned.id
  });
  if (rpcErr || !subId) throw new Error(`exam_create_submission failed: ${rpcErr?.message}`);
  const submissionId = subId as number;

  // Build the submission's files + artifact, then stamp finalized_at. We only reach here
  // when finalized_at is NULL; every step below is idempotent so a resumed finalize (after
  // a crash) re-runs them safely. pageBytes fetches each page image at most once.
  {
    const pageBytes = new Map<string, Promise<Uint8Array>>();
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

    // Idempotent rebuild WITHOUT deleting existing rows: a blanket delete of the
    // submission's files would fail once a grader has commented on a page (the
    // submission_file_comments / submission_artifacts FKs are NO ACTION) and could wipe
    // unrelated rows. Instead refresh the page bytes in storage (upsert) and insert only
    // the file rows that don't already exist (keyed by the deterministic page name).
    const { data: existingFiles } = await admin
      .from("submission_files")
      .select("name")
      .eq("submission_id", submissionId);
    const existingNames = new Set((existingFiles ?? []).map((f) => f.name));

    const pageRefs: { page_number: number; storage_key: string; width: number; height: number }[] = [];
    for (let i = 0; i < groupPages.length; i++) {
      const p = groupPages[i];
      const name = `exam-page-${i + 1}.png`;
      const bytes = await downloadImageCached(admin, pageBytes, "exam-scans", p.image_path);
      const storageKey = `classes/${classId}/profiles/${profileId}/submissions/${submissionId}/files/${name}`;
      const up = await admin.storage.from("submission-files").upload(storageKey, bytes, {
        contentType: "image/png",
        upsert: true
      });
      if (up.error) throw new Error(`upload ${storageKey} failed: ${up.error.message}`);
      if (!existingNames.has(name)) {
        const { error: fileErr } = await admin.from("submission_files").insert({
          submission_id: submissionId,
          name,
          class_id: classId,
          profile_id: profileId,
          is_binary: true,
          mime_type: "image/png",
          file_size: bytes.length,
          storage_key: storageKey,
          contents: null
        });
        if (fileErr) throw new Error(`insert submission file ${name} failed: ${fileErr.message}`);
      }
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
          const bytes = await downloadImageCached(admin, pageBytes, "exam-scans", page.image_path);
          const img: PageImage = { name: page.image_path, bytes, width: page.width ?? 0, height: page.height ?? 0 };
          const structured = await provider.structureAnswer(answerType, img, rect, ocrText);
          structuredValue = structured.value;
        } catch {
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

    // The exam artifact (written before the finalized_at stamp). The partial unique index
    // (submission_artifacts_one_exam_v1_per_submission) guarantees at most one; a concurrent
    // finalize that already inserted it trips that unique violation, which we treat as
    // "already done" rather than failing the message.
    const { error: artErr } = await admin.from("submission_artifacts").insert({
      submission_id: submissionId,
      class_id: classId,
      profile_id: profileId,
      name: "Exam",
      data: { format: EXAM_ARTIFACT_FORMAT, pages: pageRefs, questions } as unknown as Json
    });
    if (artErr && !/duplicate key|unique/i.test(artErr.message)) {
      throw new Error(`artifact insert failed: ${artErr.message}`);
    }

    // Stamp the completion marker LAST — only now is this scanned submission fully finalized.
    // Throw on failure so the message requeues (otherwise finalize "succeeds" but the batch
    // never completes and the work is silently re-done on the next enqueue).
    const { error: stampErr } = await admin
      .from("exam_scanned_submissions")
      .update({ finalized_at: new Date().toISOString() })
      .eq("id", scanned.id);
    if (stampErr) throw new Error(`stamp finalized_at for ${scanned.id} failed: ${stampErr.message}`);
  }

  await maybeCompleteBatch(admin, scanned.batch_id);
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
    // env.args is narrowed by env.method (discriminated ExamAsyncEnvelope) — no casts needed.
    if (env.method === "process_page") {
      await processPage(admin, env.args);
    } else if (env.method === "match") {
      await doMatch(admin, env.class_id, env.args);
    } else if (env.method === "finalize") {
      await finalize(admin, env.class_id, env.args);
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
  // Fail closed: never fall back to a hard-coded secret. If EDGE_FUNCTION_SECRET is unset
  // the function rejects every request rather than accepting a guessable default.
  const expected = Deno.env.get("EDGE_FUNCTION_SECRET");
  if (!expected || secret !== expected) {
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
