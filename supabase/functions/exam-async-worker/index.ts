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
// Cap rate-limit requeues. requeue() sends a FRESH pgmq message (read_ct resets to 0), so the
// PGMQ_MAX_READ_CT poison-pill guard never trips on the requeue path; without this bound a
// message behind a permanently-exhausted provider quota would requeue forever.
const MAX_RATE_LIMIT_RETRIES = 20;
// `match` must not run until every process_page message for the batch has finished OCR (they
// are separate queue messages and may be handled by concurrent worker invocations). When OCR
// is still outstanding the match message re-queues itself with this delay, bounded by
// MAX_OCR_WAIT_RETRIES -- ~15 min, comfortably longer than OCR of a large batch, after which
// it is treated as a real failure so the batch surfaces an error instead of waiting forever.
const OCR_WAIT_SECONDS = 30;
const MAX_OCR_WAIT_RETRIES = 30;

type QueueMessage = {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  message: ExamAsyncEnvelope;
};

type Admin = SupabaseClient<Database>;

async function archive(admin: Admin, msgId: number): Promise<void> {
  // The one queue call whose error is deliberately ignored. A failed archive leaves the message
  // to be redelivered and the handler re-run, which every handler here is written to tolerate
  // (at-least-once). Throwing would turn a harmless duplicate delivery into a batch-level
  // failure -- the opposite trade-off from sendEnvelope, where a swallowed failure LOSES work.
  await admin.schema("pgmq_public").rpc("archive", { queue_name: QUEUE, message_id: msgId });
}

async function requeue(admin: Admin, env: ExamAsyncEnvelope, delaySeconds: number): Promise<void> {
  // Preserve the (method, args) pairing of the discriminated envelope; only bump retry_count.
  const next = { ...env, retry_count: (env.retry_count ?? 0) + 1 };
  await sendEnvelope(admin, next, delaySeconds);
}

// Park a message without spending its transient-error budget: bumps ocr_waits, not retry_count.
async function requeueWaitingForOcr(admin: Admin, env: ExamAsyncEnvelope, delaySeconds: number): Promise<void> {
  const next = { ...env, ocr_waits: (env.ocr_waits ?? 0) + 1 };
  await sendEnvelope(admin, next, delaySeconds);
}

async function sendEnvelope(admin: Admin, next: ExamAsyncEnvelope, delaySeconds: number): Promise<void> {
  const { error } = await admin.schema("pgmq_public").rpc("send", {
    queue_name: QUEUE,
    message: next as unknown as Json,
    sleep_seconds: delaySeconds
  });
  // Throwing is what preserves the job. Every caller is followed by archive() of the message
  // being replaced, so swallowing a failed send would archive the original with no replacement
  // queued -- the OCR, match or finalize work would simply vanish. Throwing instead propagates
  // out before that archive, leaving the original message to reappear when its pgmq visibility
  // timeout lapses. (Reported by Codex against 13b45d59; the omission predates the sendEnvelope
  // refactor but that refactor put both the retry and the OCR-wait path through it.)
  if (error) throw new Error(`requeue ${next.method} (batch ${next.batch_id}) failed: ${error.message}`);
}

async function deadLetter(admin: Admin, env: ExamAsyncEnvelope, msgId: number, error: unknown): Promise<void> {
  // Same shape of omission as sendEnvelope above: the caller archives the original right after
  // this, so dead-lettering that fails silently drops the job. There are TWO records here and
  // either one suffices -- the DLQ message (replayable) and the audit row (durable, queryable)
  // -- so a single failure is reported and tolerated. Both failing is different: nothing
  // anywhere would remember the job, so throw and let the original message come back after its
  // visibility timeout instead of being archived into oblivion.
  const { error: dlqErr } = await admin
    .schema("pgmq_public")
    .rpc("send", { queue_name: DLQ, message: env as unknown as Json, sleep_seconds: 0 });
  if (dlqErr) {
    console.error(`dead-letter queue send failed for ${env.method} (batch ${env.batch_id}): ${dlqErr.message}`);
    Sentry.captureException(new Error(`dead-letter queue send failed: ${dlqErr.message}`));
  }
  const { error: auditErr } = await admin.from("exam_async_worker_dlq_messages").insert({
    original_msg_id: msgId,
    method: env.method,
    envelope: env as unknown as Json,
    error_message: error instanceof Error ? error.message : String(error),
    error_type: error instanceof Error ? error.constructor.name : "Unknown",
    retry_count: env.retry_count ?? 0,
    class_id: env.class_id,
    debug_id: env.debug_id ?? null
  });
  if (auditErr) {
    console.error(`dead-letter audit insert failed for ${env.method} (batch ${env.batch_id}): ${auditErr.message}`);
    Sentry.captureException(new Error(`dead-letter audit insert failed: ${auditErr.message}`));
  }
  if (dlqErr && auditErr) {
    // Yes, this can loop: the caller skips its archive, the message redelivers, and dead-lettering
    // is attempted again. That is intended. Both a pgmq send AND a plain table insert failing
    // means the database is effectively unavailable, and retrying until it recovers is strictly
    // better than archiving a student's scanned exam into nothing. pgmq messages do not expire,
    // and the worker only runs on its invocation cadence, so this costs one failed attempt per
    // run rather than a hot spin.
    throw new Error(
      `dead-lettering ${env.method} (batch ${env.batch_id}) failed on BOTH the queue send and the audit insert; ` +
        `refusing to archive the original message (queue: ${dlqErr.message}; audit: ${auditErr.message})`
    );
  }
}

async function setBatchError(admin: Admin, batchId: number, message: string): Promise<void> {
  // The batch's status IS how staff learn something failed, so a silent failure here leaves a
  // batch sitting in 'ocr'/'finalizing' forever with nothing explaining why. Throwing keeps the
  // message unarchived so the status write is retried.
  //
  // Callers run this BEFORE deadLetter for that reason: if it were second, a failure would
  // redeliver a message that had already been dead-lettered, appending a duplicate DLQ message
  // and audit row on every attempt.
  const { error: updErr } = await admin
    .from("exam_scan_batches")
    .update({ status: "error", error: message })
    .eq("id", batchId);
  if (updErr) throw new Error(`mark batch ${batchId} errored failed: ${updErr.message}`);
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
  // Not optional: an empty roster makes every name lookup miss, so a failed read would mark a
  // whole batch unmatched (or match on the SIS id alone) instead of failing and retrying.
  const { data, error } = await admin
    .from("user_roles")
    .select("private_profile_id, profiles!user_roles_private_profile_id_fkey(name)")
    .eq("class_id", classId)
    .eq("role", "student");
  if (error) throw new Error(`load roster for class ${classId} failed: ${error.message}`);
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
  const { data: user, error: userErr } = await admin
    .from("users")
    .select("user_id")
    .eq("sis_user_id", parseInt(detectedSisId, 10))
    .maybeSingle();
  // Distinguish "no such SIS id" from "the lookup failed": returning null for the latter
  // silently downgrades a confident SIS match to a name guess, or to unmatched.
  if (userErr) throw new Error(`look up SIS id ${detectedSisId} failed: ${userErr.message}`);
  if (!user?.user_id) return null;
  const { data: ur, error: urErr } = await admin
    .from("user_roles")
    .select("private_profile_id")
    .eq("class_id", classId)
    .eq("role", "student")
    .eq("user_id", user.user_id)
    .maybeSingle();
  if (urErr) throw new Error(`look up enrollment for SIS id ${detectedSisId} failed: ${urErr.message}`);
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

async function doMatch(admin: Admin, env: ExamAsyncEnvelope, args: MatchArgs): Promise<void> {
  const classId = env.class_id;
  const provider = getExamVisionProvider();
  const { data: batch, error } = await admin
    .from("exam_scan_batches")
    .select("id, exam_id, pages_per_exam")
    .eq("id", args.batch_id)
    .single();
  if (error || !batch) throw new Error(`batch ${args.batch_id} not found`);

  // Join the OCR fan-out before doing anything else. enqueue_exam_process_batch sends one
  // process_page message per page plus this single match message, with no ordering guarantee
  // between them, so match can win the race while pages are still un-OCR'd. That mattered
  // twice over: identity is read from OCR words (so a match would be made from missing text),
  // and the unconditional `status = 'review'` below opens confirm/finalize in the UI --
  // finalize treats a page with no ocr_data as having no words and then stamps finalized_at,
  // permanently recording an incomplete artifact that later OCR completion never rebuilds.
  const { count: pendingOcr, error: pendingErr } = await admin
    .from("exam_scan_pages")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batch.id)
    .is("ocr_data", null);
  if (pendingErr) throw new Error(`count pending OCR for batch ${batch.id} failed: ${pendingErr.message}`);
  if ((pendingOcr ?? 0) > 0) {
    const waits = env.ocr_waits ?? 0;
    if (waits >= MAX_OCR_WAIT_RETRIES) {
      throw new Error(
        `batch ${batch.id} still has ${pendingOcr} page(s) without OCR after ${waits} waits; not advancing to review`
      );
    }
    // Fresh message, then the dispatcher archives this copy on our normal return. Leave the
    // batch status alone so the scans page keeps showing it as still processing.
    await requeueWaitingForOcr(admin, env, OCR_WAIT_SECONDS);
    return;
  }

  const { error: matchingErr } = await admin
    .from("exam_scan_batches")
    .update({ status: "matching" })
    .eq("id", batch.id);
  if (matchingErr) throw new Error(`set batch ${batch.id} to matching failed: ${matchingErr.message}`);

  const perExam = Math.max(1, batch.pages_per_exam);
  const { data: pages, error: pagesErr } = await admin
    .from("exam_scan_pages")
    .select("id, page_index, image_path, width, height")
    .eq("batch_id", batch.id)
    .order("page_index", { ascending: true });
  // A discarded error here read as "the batch legitimately has no pages" and marked it `review`.
  // No match rows get created, and the scans page only offers reprocessing for `uploaded` or
  // `error` batches -- so one transient database failure stranded the batch in an empty review
  // state with no way back. Throw so the queue retry path runs instead.
  if (pagesErr) throw new Error(`load scan pages for batch ${batch.id} failed: ${pagesErr.message}`);
  if (!pages || pages.length === 0) {
    const { error: emptyReviewErr } = await admin
      .from("exam_scan_batches")
      .update({ status: "review" })
      .eq("id", batch.id);
    if (emptyReviewErr) throw new Error(`set empty batch ${batch.id} to review failed: ${emptyReviewErr.message}`);
    return;
  }
  // Refuse a page count that is not a whole number of exams. Math.ceil below would otherwise
  // make the last group short, and that group sails through review and finalization with the
  // regions for its missing template pages silently skipped -- a permanently incomplete
  // artifact for a real student. enqueue_exam_process_batch already checks that every declared
  // page persisted; this is the separate question of whether the pages divide into exams.
  if (pages.length % perExam !== 0) {
    throw new Error(
      `batch ${batch.id} has ${pages.length} pages, which is not a multiple of ${perExam} page(s) per exam; ` +
        `re-scan the batch or correct pages-per-exam before processing`
    );
  }

  // identity regions (kind name/student_id) defined on the template. A template may
  // define one of each; when both exist we read each independently (they can sit on
  // different pages) and combine the two signals to disambiguate the student.
  const { data: idRegions, error: idRegionsErr } = await admin
    .from("exam_question_regions")
    .select("kind, page_number, x, y, width, height")
    .eq("exam_id", batch.exam_id)
    .in("kind", ["student_id", "name"]);
  // Not checking this meant a failed load looked like "no identity regions defined", which
  // silently falls back to reading the whole first page -- degrading every match in the batch
  // rather than failing.
  if (idRegionsErr) {
    throw new Error(`load identity regions for exam ${batch.exam_id} failed: ${idRegionsErr.message}`);
  }
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
    // Index the requested template page directly. Clamping to the last available page meant an
    // identity region on template page 4, in a batch whose pages_per_exam only supplies 3, was
    // read from page 3 using page-4 coordinates -- the same wrong-page behaviour that was
    // removed from answer-region handling. The divisibility check does not cover this: it
    // proves the upload divides into whole exams, not that pages_per_exam spans every template
    // page a region references.
    const page = groupPages[pageNumber - 1];
    if (!page) {
      throw new Error(
        `identity region references template page ${pageNumber}, but each exam in batch ${batch.id} ` +
          `has only ${groupPages.length} page(s); correct pages-per-exam or the region's page`
      );
    }
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
    // A discarded error here entered the insert branch as though the group did not exist. With
    // no uniqueness on (batch_id, exam_index) that silently created a SECOND review row for the
    // same logical exam; the unique index added alongside this makes such an insert fail safely
    // even if this check is ever bypassed.
    const { data: existing, error: existingErr } = await admin
      .from("exam_scanned_submissions")
      .select("id, match_status")
      .eq("batch_id", batch.id)
      .eq("exam_index", g)
      .maybeSingle();
    if (existingErr) {
      throw new Error(`look up scanned submission (batch ${batch.id}, index ${g}) failed: ${existingErr.message}`);
    }
    if (existing?.id) {
      scannedId = existing.id;
      // A re-run of the match phase (re-process, or a redelivered 'match' message) must
      // never clobber a decision a human already made.
      humanDecided = existing.match_status === "confirmed" || existing.match_status === "skipped";
    } else {
      // UPSERT on the (batch_id, exam_index) unique index rather than a bare insert. Matching a
      // large batch can outlast the queue's 120s visibility window, so a second worker can pick
      // up the same `match` message, see no row in the lookup above, and insert concurrently.
      // The unique index makes that fail rather than duplicate, but failing would DLQ the batch;
      // ignoreDuplicates + a select makes the whole lookup-or-create idempotent, so whichever
      // worker loses the race simply adopts the existing row.
      const { error: upsertErr } = await admin
        .from("exam_scanned_submissions")
        .upsert(
          { class_id: classId, exam_id: batch.exam_id, batch_id: batch.id, exam_index: g },
          { onConflict: "batch_id,exam_index", ignoreDuplicates: true }
        );
      if (upsertErr) throw new Error(`create scanned submission failed: ${upsertErr.message}`);
      const { data: created, error: reReadErr } = await admin
        .from("exam_scanned_submissions")
        .select("id, match_status")
        .eq("batch_id", batch.id)
        .eq("exam_index", g)
        .single();
      if (reReadErr || !created) {
        throw new Error(`read back scanned submission (batch ${batch.id}, index ${g}) failed: ${reReadErr?.message}`);
      }
      scannedId = created.id;
      // The row may have been created by the concurrent worker AND already decided by a human
      // between our lookup and now; respect that exactly as the found-row branch does.
      humanDecided = created.match_status === "confirmed" || created.match_status === "skipped";
    }
    // Check this one: it is the only link between a scanned submission and its pages. Failing
    // silently left the row with no pages attached, and finalize would then have nothing to
    // assemble -- it now refuses that case loudly, but failing here points at the actual cause
    // instead of surfacing three steps later.
    const { error: linkErr } = await admin
      .from("exam_scan_pages")
      .update({ scanned_submission_id: scannedId })
      .in(
        "id",
        groupPages.map((p) => p.id)
      );
    if (linkErr) {
      throw new Error(`link pages to scanned submission ${scannedId} failed: ${linkErr.message}`);
    }

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

  // Conditional transition. A large match job can outlast the 120s visibility window, so a
  // duplicate worker may still be running this after staff have finalized the batch -- an
  // unconditional write would then stamp 'review' over 'completed' or 'error', hiding the
  // terminal result. Only advance from the states that precede review.
  const { error: reviewErr } = await admin
    .from("exam_scan_batches")
    .update({ status: "review" })
    .eq("id", batch.id)
    .in("status", ["uploaded", "ocr", "matching", "error"]);
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
  // A failed count is NOT zero, and the two failure modes here are opposite and both bad: a
  // failed confirmed-count reads as "nothing confirmed" and returns early, leaving a fully
  // finalized batch stuck in 'finalizing' forever; a failed pending-count reads as "nothing
  // outstanding" and marks the batch completed while confirmed submissions still have no
  // artifact. Throw so the finalize message retries instead.
  const { count: confirmedCount, error: confirmedErr } = await admin
    .from("exam_scanned_submissions")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("match_status", "confirmed");
  if (confirmedErr) throw new Error(`count confirmed for batch ${batchId} failed: ${confirmedErr.message}`);
  if ((confirmedCount ?? 0) === 0) return;
  const { count: pending, error: pendingErr } = await admin
    .from("exam_scanned_submissions")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("match_status", "confirmed")
    .is("finalized_at", null);
  if (pendingErr) throw new Error(`count pending for batch ${batchId} failed: ${pendingErr.message}`);
  if ((pending ?? 0) === 0) {
    const { error: completeErr } = await admin
      .from("exam_scan_batches")
      .update({ status: "completed" })
      .eq("id", batchId);
    if (completeErr) throw new Error(`complete batch ${batchId} failed: ${completeErr.message}`);
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
    const { data: pages, error: pagesErr } = await admin
      .from("exam_scan_pages")
      .select("id, page_index, image_path, width, height, ocr_data")
      .eq("scanned_submission_id", scanned.id)
      .order("page_index", { ascending: true });
    // Never coalesce this to []. A transient PostgREST failure would otherwise read as "this
    // exam has no pages": the loop below skips every question region, the exam_v1 artifact is
    // written empty, and finalized_at is stamped -- which permanently marks the submission
    // finalized, so no retry ever rebuilds it. Throwing requeues the message instead.
    if (pagesErr) throw new Error(`load scan pages for scanned submission ${scanned.id} failed: ${pagesErr.message}`);
    if (!pages || pages.length === 0) {
      throw new Error(
        `scanned submission ${scanned.id} has no scan pages; refusing to finalize an empty exam artifact`
      );
    }
    const groupPages = pages;

    // Idempotent rebuild WITHOUT deleting existing rows: a blanket delete of the
    // submission's files would fail once a grader has commented on a page (the
    // submission_file_comments / submission_artifacts FKs are NO ACTION) and could wipe
    // unrelated rows. Instead refresh the page bytes in storage (upsert) and insert only
    // the file rows that don't already exist (keyed by the deterministic page name).
    const { data: existingFiles, error: existingFilesErr } = await admin
      .from("submission_files")
      .select("name")
      .eq("submission_id", submissionId);
    // An error read as "no files exist yet", so a resumed finalize would re-insert rows that are
    // already there. That surfaces as a unique violation rather than corruption, but failing at
    // the actual cause is clearer than failing a step later.
    if (existingFilesErr) {
      throw new Error(`load existing submission files for ${submissionId} failed: ${existingFilesErr.message}`);
    }
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
    const { data: regions, error: regionsErr } = await admin
      .from("exam_question_regions")
      .select("exam_question_id, page_number, x, y, width, height, exam_questions(answer_type)")
      .eq("exam_id", scanned.exam_id)
      .eq("kind", "answer")
      .not("exam_question_id", "is", null);
    // Same trap as the scan-page load: a discarded error looked like "this exam defines no
    // answer regions", so the artifact below was written with an empty questions[] and then
    // stamped finalized_at -- permanent, and never rebuilt on retry.
    if (regionsErr) {
      throw new Error(`load answer regions for exam ${scanned.exam_id} failed: ${regionsErr.message}`);
    }

    const questions: unknown[] = [];
    for (const r of regions ?? []) {
      // Answer-region page_number is a TEMPLATE page index; map it directly onto this
      // student's scan pages (already ordered + filtered to this submission). Do NOT clamp to
      // pages_per_exam — that silently pulled OCR from the wrong page for a region sitting on a
      // page beyond pages_per_exam. A region past this submission's scanned page count is skipped.
      const examPageNo = Math.max(1, r.page_number);
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
        } catch (structureErr) {
          // A bare catch also swallowed ProviderRateLimitError, so a rate limit or timeout was
          // treated as "this answer cannot be structured": the raw OCR string was substituted,
          // the artifact written, and finalized_at stamped -- permanently degrading a gradeable
          // answer that the worker's own backoff would have recovered. Retryable provider
          // failures now propagate to the dispatcher's rate-limit path; the fallback is reserved
          // for genuinely unstructurable content (e.g. illegible handwriting).
          if (structureErr instanceof ProviderRateLimitError) throw structureErr;
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
    if (env.batch_id) await setBatchError(admin, env.batch_id, err.message);
    await deadLetter(admin, env, msg.msg_id, err);
    await archive(admin, msg.msg_id);
    return;
  }

  try {
    // env.args is narrowed by env.method (discriminated ExamAsyncEnvelope) — no casts needed.
    if (env.method === "process_page") {
      await processPage(admin, env.args);
    } else if (env.method === "match") {
      await doMatch(admin, env, env.args);
    } else if (env.method === "finalize") {
      await finalize(admin, env.class_id, env.args);
    } else {
      throw new Error(`unknown method ${(env as { method: string }).method}`);
    }
    await archive(admin, msg.msg_id);
  } catch (error) {
    if (error instanceof ProviderRateLimitError) {
      // Rate limits are transient, but bound the retries (see MAX_RATE_LIMIT_RETRIES) so a
      // permanently-exhausted quota can't requeue forever.
      if ((env.retry_count ?? 0) >= MAX_RATE_LIMIT_RETRIES) {
        Sentry.captureException(error, scope);
        if (env.batch_id)
          await setBatchError(admin, env.batch_id, error instanceof Error ? error.message : String(error));
        await deadLetter(admin, env, msg.msg_id, error);
        await archive(admin, msg.msg_id);
        return;
      }
      // requeue this message with the provider's backoff; archive the current copy
      await requeue(admin, env, error.retryAfterSeconds);
      await archive(admin, msg.msg_id);
      return;
    }
    const retryCount = env.retry_count ?? 0;
    if (retryCount >= 5) {
      Sentry.captureException(error, scope);
      if (env.batch_id)
        await setBatchError(admin, env.batch_id, error instanceof Error ? error.message : String(error));
      await deadLetter(admin, env, msg.msg_id, error);
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
      // Isolate per-message failures. processMessage handles its own errors, but it can now
      // throw on the way out: sendEnvelope throws when a requeue cannot be queued (deliberately,
      // so the original is not archived without a replacement). Letting that escape would
      // abandon the rest of this read batch. Nothing is lost either way -- an un-archived
      // message reappears when its 120s visibility timeout lapses -- but the remaining
      // messages should not have to wait for that.
      try {
        await processMessage(admin, msg, scope.clone());
      } catch (error) {
        Sentry.captureException(error, scope.clone());
        console.error(`processMessage failed for msg ${msg.msg_id}; leaving it queued for redelivery`, error);
      }
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
