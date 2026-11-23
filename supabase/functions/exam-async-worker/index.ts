import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import type { Json } from "../_shared/SupabaseTypes.d.ts";
import type { ExamAsyncEnvelope, FinalizeArgs, MatchArgs, ProcessPageArgs } from "../_shared/ExamAsyncTypes.ts";
import { FINALIZE_ANSWER_REGION_SELECT } from "./finalizeQueries.ts";
import {
  COMPLETED_FROM,
  errorFrom,
  isTransitionOutcome,
  MATCHING_FROM,
  REJECTED_SCAN_ERROR_FROM,
  REVIEW_FROM,
  type BatchStatus,
  type TransitionOutcome
} from "./batchTransitions.ts";
import {
  getExamVisionProvider,
  ProviderRateLimitError,
  ProviderTransientError,
  wordsInRegion,
  type NormRect,
  type PageImage
} from "../_shared/examVision.ts";
import { assertScanPathInScope, ScanPathRejectedError, type ScanScope } from "../_shared/examScanPath.ts";
import { holdLease } from "../_shared/examWorkerLease.ts";
import {
  ack,
  contractStatus,
  FenceRpcError,
  giveUp as giveUpFenced,
  linkScanGroups,
  requeue as requeueFenced,
  setMatchSuggestion,
  type Claim,
  type LinkOutcome
} from "../_shared/examWorkerFence.ts";
import { nextOcrWait, ocrWaitBoundaryMs } from "./ocrWait.ts";
import { claimDeadlineMs, isolateLifetimeMs } from "./claimWindow.ts";
import { mapRectToScan, wordsToTemplate } from "../_shared/examRegistration.ts";
import { alignBatch, loadTemplates, ocrWords, requireAligned, toOcrData } from "./pageAlignment.ts";
import { downloadImage, downloadImageCached } from "./storage.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const QUEUE = "exam_processing";
// When this isolate evaluated the module: the anchor for when to stop claiming (claimWindow.ts).
const ISOLATE_STARTED_AT_MS = Date.now();
const PGMQ_MAX_READ_CT = 8;
// Cap rate-limit requeues. requeue() sends a FRESH pgmq message (read_ct resets to 0), so the
// PGMQ_MAX_READ_CT poison-pill guard never trips on the requeue path; without this bound a
// message behind a permanently-exhausted provider quota would requeue forever.
const MAX_RATE_LIMIT_RETRIES = 20;
// `match` must not run until every process_page message for the batch has finished OCR (they
// are separate queue messages and may be handled by concurrent worker invocations). When OCR
// is still outstanding the match message re-queues itself with this delay. The delay is short
// because runBatch claims one message at a time, so overlapping invocations often get `match`
// while its own pages are still in OCR (#1158), and the batch reaches review one delay later.
//
// When the wait counts as a failure, so the batch surfaces an error instead of waiting forever, is
// nextOcrWait in ./ocrWait.ts: never sooner than the 30 waits of 30s before #1158.
const OCR_WAIT_SECONDS = 5;

type QueueMessage = {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  // Set by the read to clock_timestamp() + READ_VISIBILITY_SECONDS: the read's own database time,
  // which the OCR wait counts from (ocrWait.ts).
  vt: string;
  message: ExamAsyncEnvelope;
};

type Admin = SupabaseClient<Database>;

// The claim a handler runs under: the message and the read_ct its read produced. Every batch status
// write, match write and queue disposition carries it, so a handler that no longer holds the
// message changes nothing (#1158; see ../_shared/examWorkerFence.ts).
type Fence = Claim;

// Thrown when a fenced write finds that another reader holds the message now. processMessage then
// returns without requeueing, dead-lettering or acknowledging: those belong to the current holder.
// Writes the handler made before that point stay, and rely on their own guards (first-writer OCR,
// idempotent finalize steps).
class NotOwnerError extends Error {}

// The one place the worker writes exam_scan_batches.status. See exam_worker_set_batch_status
// (20261122130000_pgmq_public_set_vt_if_claimed.sql) and batchTransitions.ts.
async function setBatchStatus(
  admin: Admin,
  fence: Fence,
  batchId: number,
  status: BatchStatus,
  from: readonly BatchStatus[],
  errorMessage?: string
): Promise<TransitionOutcome> {
  const { data, error } = await admin.rpc("exam_worker_set_batch_status", {
    p_msg_id: fence.msgId,
    p_read_ct: fence.readCt,
    p_batch_id: batchId,
    p_status: status,
    p_from: [...from],
    p_error: errorMessage ?? undefined
  });
  if (!error) {
    if (isTransitionOutcome(data)) return data;
    throw new Error(`set batch ${batchId} to ${status}: unexpected reply ${JSON.stringify(data)}`);
  }
  // No fallback for a missing function: runBatch does not claim until the database contract is
  // deployed (contractStatus), so a missing function here is an error like any other.
  throw new Error(`set batch ${batchId} to ${status} failed: ${error.message}`);
}

/**
 * Matching refused to regroup pages because the grouping would change the pages of an exam a human
 * confirmed or skipped, or that has been finalized (exam_link_scan_groups, errcode EX409). Retrying
 * gives the same answer, so it is dead-lettered at once and shown on the batch, as a rejected scan is.
 */
class ScanGroupChangeRejectedError extends ScanPathRejectedError {
  constructor(message: string) {
    super(message);
    this.name = "ScanGroupChangeRejectedError";
  }
}

// ---------------------------------------------------------------------------
// Logging (#1157)
// ---------------------------------------------------------------------------
// This worker had three console statements and all three sat on error paths, so a run that went
// wrong showed nothing at all. In the CI run for #1088 (run 40775885939) it was invoked 197 times
// and printed not one line of its own, while discord-async-worker logged every pass beside it. The
// cause was getExamVisionProvider() throwing because EXAM_VISION_PROVIDER was unset, which one line
// would have said outright; instead the only symptom was a batch sitting at "ocr".
//
// These lines answer one question: did it run, and what did it see. The prefix follows the
// [scope] convention discord-async-worker uses, so the two read the same way in one log artifact.
function log(message: string): void {
  console.log(`[exam-async-worker] ${message}`);
}

// What a handler leaves the dispatcher to do with its message: acknowledge it (done, including every
// early return), or replace it with a re-queued copy (match waiting for OCR).
type Disposition =
  | { kind: "ack" }
  | { kind: "requeue"; message: ExamAsyncEnvelope; delaySeconds: number; countWait: boolean };
const ACK: Disposition = { kind: "ack" };

// Acknowledge or re-queue the held message, only while this reader still holds it
// (exam_worker_ack / exam_worker_requeue). A reader that was taken over leaves the message to the
// reader that holds it now: it is running the same work, and removing or forking its message
// would end that work under it or run it twice.
//
// An acknowledgment that fails is logged, not thrown: the message comes back after its lease and
// the handler runs again, which every handler here tolerates (at-least-once). A re-queue that
// fails throws, so nothing is archived without its replacement; the original comes back instead.
async function dispose(admin: Admin, fence: Fence, env: ExamAsyncEnvelope, next: Disposition): Promise<void> {
  if (next.kind === "ack") {
    let outcome: "acked" | "not_owner";
    try {
      outcome = await ack(admin, fence);
    } catch (error) {
      console.error(
        `exam-async-worker: ack of msg ${fence.msgId} failed; it comes back after its lease: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (outcome === "not_owner") {
      console.warn(`exam-async-worker: msg ${fence.msgId} was taken over before its ack; leaving it to the new holder`);
    }
    return;
  }
  const outcome = await requeueFenced(admin, fence, next.message, next.delaySeconds, next.countWait);
  if (outcome === "not_owner") {
    console.warn(
      `exam-async-worker: msg ${fence.msgId} was taken over before its ${env.method} re-queue; leaving it to the new holder`
    );
  }
}

// Give up on the held message: error the batch (from `from` only), record the failure on the DLQ
// queue and in exam_async_worker_dlq_messages, and archive the message, in one transaction
// (exam_worker_give_up), only while this reader still holds it. All or nothing, so a batch can no
// longer be errored by a give-up whose archive then never happened, leaving a redelivery to finish
// the work under the error. Either dead-letter record suffices; one failing is reported here. Both
// failing throws, and the message comes back.
async function giveUpMessage(
  admin: Admin,
  fence: Fence,
  envelope: unknown,
  batchId: number | null,
  from: readonly BatchStatus[],
  error: unknown
): Promise<"given_up" | "not_owner"> {
  const outcome = await giveUpFenced(admin, fence, {
    batchId,
    from,
    error: error instanceof Error ? error.message : String(error),
    errorType: error instanceof Error ? error.constructor.name : "Unknown",
    envelope
  });
  if (outcome === "given_up:no_dlq_message" || outcome === "given_up:no_audit_row") {
    const missing = outcome === "given_up:no_dlq_message" ? "dead-letter queue send" : "dead-letter audit insert";
    console.error(`exam-async-worker: msg ${fence.msgId} given up, but its ${missing} failed`);
    Sentry.captureException(new Error(`${missing} failed for msg ${fence.msgId}`));
  }
  return outcome === "not_owner" ? "not_owner" : "given_up";
}

// Which class, exam and batch a page's image_path must name (#1078). Taken from the batch row:
// staff write image_path, and the page's own exam_id is not tied to its batch's exam.
async function loadScanScope(admin: Admin, batchId: number): Promise<ScanScope> {
  const { data, error } = await admin
    .from("exam_scan_batches")
    .select("id, class_id, exam_id")
    .eq("id", batchId)
    .single();
  if (error || !data) throw new Error(`load scan batch ${batchId} failed: ${error?.message}`);
  return { classId: data.class_id, examId: data.exam_id, batchId: data.id };
}

// ---------------------------------------------------------------------------
// process_page: OCR one scan page
// ---------------------------------------------------------------------------
async function processPage(admin: Admin, batchId: number, args: ProcessPageArgs): Promise<void> {
  const provider = getExamVisionProvider();
  const { data: page, error } = await admin
    .from("exam_scan_pages")
    .select("id, batch_id, image_path, width, height, ocr_data")
    .eq("id", args.scan_page_id)
    .single();
  if (error || !page) throw new Error(`scan page ${args.scan_page_id} not found`);
  // The message was enqueued for batchId, and that batch is what the enqueue RPC authorized. Staff
  // can move a page to another batch of the course afterwards; this job is then obsolete, so it
  // reads nothing and does not error either batch (the page's new batch has its own processing).
  if (page.batch_id !== batchId) return;
  // Idempotent: already OCR'd. Keyed on ocr_data (as the match step's completeness check is),
  // not ocr_text, which is "" for a blank page and would re-send it to the provider every time.
  if (page.ocr_data !== null) return;

  assertScanPathInScope(page.image_path, await loadScanScope(admin, batchId), `scan page ${page.id}`);
  const bytes = await downloadImage(admin, "exam-scans", page.image_path);
  const img: PageImage = {
    name: page.image_path,
    bytes,
    width: page.width ?? 0,
    height: page.height ?? 0
  };
  const result = await provider.ocrImage(img);
  // Only while the page is still in this batch: if staff moved it during the OCR call, the result
  // belongs to no queued work and is dropped (a zero-row update is not an error).
  //
  // And only while the page has no OCR yet: the first result written for a page is the one kept
  // (#1158). A reader whose lease lapsed during the provider call, or a second process_page for the
  // same page, may finish after another result was stored and match or finalize read it; replacing
  // it would change, under them, the words they grouped, identified and graded on. Two readers
  // racing here are reading the same image_path, so which result is kept does not matter; that it
  // then stays the same does. This is not claim ownership: an expired holder that finishes first
  // still writes. It changes nothing outside that race: the early return above already skips any
  // page that has OCR, as before #1158, so re-running Process never re-reads a page (including an
  // unlinked page whose image staff replaced, which keeps its old OCR). The page guard
  // (20261118150200) is narrower: it stops staff, not the worker, changing a linked page's OCR.
  const { error: updErr } = await admin
    .from("exam_scan_pages")
    .update({ ocr_text: result.text, ocr_data: toOcrData(result.words) })
    .eq("id", args.scan_page_id)
    .eq("batch_id", batchId)
    .is("ocr_data", null);
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
  // Collect ALL matches, not the first. Two students who normalize to the same name made
  // .find() hand back whichever happened to come first, as a 0.6-confidence suggestion -- and
  // the review selector labels both profiles with just that name, so staff had no way to tell
  // which paper belonged to whom and could confirm a submission for the wrong student. An
  // ambiguous name is no evidence at all: return null so the row stays unmatched and a human
  // resolves it deliberately.
  const hits = roster.filter((r) => r.name && norm(r.name) === want);
  if (hits.length !== 1) return null;
  return hits[0].profile_id ?? null;
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

// `read` is when this message was read and enqueued, in database time (QueueMessage.vt minus the read
// window, and enqueued_at), for the OCR wait.
async function doMatch(
  admin: Admin,
  env: ExamAsyncEnvelope,
  args: MatchArgs,
  fence: Fence,
  read: { readDbMs: number; enqueuedAtMs: number }
): Promise<Disposition> {
  const classId = env.class_id;
  const provider = getExamVisionProvider();
  const { data: batch, error } = await admin
    .from("exam_scan_batches")
    .select("id, class_id, exam_id, pages_per_exam, total_pages, status")
    .eq("id", args.batch_id)
    .single();
  if (error || !batch) throw new Error(`batch ${args.batch_id} not found`);
  // Before the OCR wait below, so a stale job cannot sit out the wait and then replace an existing
  // batch error with its own.
  if (!MATCHING_FROM.includes(batch.status as BatchStatus)) return ACK;

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
    const startedMs = env.ocr_wait_started_ms ?? Date.now();
    const boundaryMs = ocrWaitBoundaryMs(waits, env.ocr_wait_from, read.enqueuedAtMs);
    const step = nextOcrWait(waits, boundaryMs, read.readDbMs);
    if (step.exhausted) {
      throw new Error(
        `batch ${batch.id} still has ${pendingOcr} page(s) without OCR after ${waits} waits over ` +
          `${Math.round((Date.now() - startedMs) / 1000)}s; not advancing to review`
      );
    }
    // A fresh message replaces this one (exam_worker_requeue, in one transaction with this one's
    // archive). Leave the batch status alone so the scans page keeps showing it as still
    // processing. A counted wait is stamped by the database; one that does not count carries the
    // boundary forward, from ocr_wait_from or, for a message an older worker re-queued, enqueued_at.
    const message: ExamAsyncEnvelope = {
      ...env,
      ocr_waits: step.waits,
      ocr_wait_started_ms: startedMs,
      ocr_wait_from: !step.counted && boundaryMs !== undefined ? new Date(boundaryMs).toISOString() : undefined,
      ocr_wait_counted_ms: undefined
    };
    return { kind: "requeue", message, delaySeconds: OCR_WAIT_SECONDS, countWait: step.counted };
  }

  // Only a batch that is still reading or matching. A match that outlived its window, or a copy
  // another reader took over, finds the batch in review/finalizing/completed (or not its message
  // any more) and stops here, before it rewrites any row.
  // The fence is per message, not per attempt: a match left over from a run that Process restarted
  // (the batch back in 'ocr') cannot be told from the new run's match. That would need an attempt
  // id on the message.
  const toMatching = await setBatchStatus(admin, fence, batch.id, "matching", MATCHING_FROM);
  if (toMatching === "not_owner") throw new NotOwnerError(`batch ${batch.id}: match message taken over`);
  if (toMatching === "state_changed") return ACK;

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
  // enqueue_exam_process_batch checked that every declared page persisted, but staff can delete or
  // move pages after that. Grouping a short batch would still produce whole exams whenever the
  // remaining pages divide evenly, just with the wrong pages in them, so require the full count on
  // the pages actually being grouped. The divisibility check below is a separate requirement.
  if ((pages?.length ?? 0) !== batch.total_pages) {
    throw new Error(
      `batch ${batch.id} has ${pages?.length ?? 0} of ${batch.total_pages} scan pages; ` +
        `re-upload the scan before processing`
    );
  }
  if (!pages || pages.length === 0) {
    if ((await setBatchStatus(admin, fence, batch.id, "review", REVIEW_FROM)) === "not_owner") {
      throw new NotOwnerError(`batch ${batch.id}: match message taken over`);
    }
    return ACK;
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
  // Check every page's image path before reading any of them for identity (#1078).
  const scanScope: ScanScope = { classId: batch.class_id, examId: batch.exam_id, batchId: batch.id };
  for (const p of pages) assertScanPathInScope(p.image_path, scanScope, `scan page ${p.id}`);

  // Line every page up with its template page before reading any region; a page that cannot be
  // refuses the batch (#1292). Before linking, so a refused batch creates no scanned exams.
  const groupCount = Math.ceil(pages.length / perExam);
  const groups = await alignBatch(
    admin,
    scanScope,
    Array.from({ length: groupCount }, (_, g) => pages.slice(g * perExam, g * perExam + perExam))
  );

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
    groupPages: (typeof groups)[number],
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
    const rect: NormRect | null = region ? mapRectToScan(region, page.reg) : null;
    return provider.readIdentity(img, rect);
  };

  const roster = await loadRoster(admin, classId);

  // Create the scanned exams and link every group in one transaction (exam_link_scan_groups). It
  // refuses, as a whole, a grouping that would change the pages of an exam a human confirmed or
  // skipped, or that has been finalized: re-processing must not regroup those onto other pages.
  // Only pages still in this batch are linked; a short count (a page moved or deleted since the
  // load above) is a plain error, so the retry reloads the batch and its count check sees it.
  // Through exam_worker_link_scan_groups: only while this reader holds the message and the batch is
  // still 'matching', so a late or taken-over match cannot regroup a batch under review.
  let linked: LinkOutcome;
  try {
    linked = await linkScanGroups(
      admin,
      fence,
      batch.id,
      groups.map((groupPages, g) => ({ exam_index: g, page_ids: groupPages.map((p) => p.id) }))
    );
  } catch (linkErr) {
    if (linkErr instanceof FenceRpcError && linkErr.code === "EX409") {
      throw new ScanGroupChangeRejectedError(`batch ${batch.id}: ${linkErr.message}`);
    }
    throw new Error(
      `link scan pages for batch ${batch.id} failed: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`
    );
  }
  if (linked.outcome === "not_owner") throw new NotOwnerError(`batch ${batch.id}: match message taken over`);
  if (linked.outcome === "state_changed") return ACK;
  const linkedRows = linked.rows;
  const rowAt = new Map(
    ((linkedRows ?? []) as { exam_index: number; scanned_submission_id: number; match_status: string }[]).map((r) => [
      r.exam_index,
      r
    ])
  );

  for (let g = 0; g < groupCount; g++) {
    const groupPages = groups[g];
    const row = rowAt.get(g);
    if (!row) throw new Error(`batch ${batch.id}: no scanned submission returned for exam ${g}; re-run matching`);
    const scannedId = row.scanned_submission_id;

    // Preserve a human's confirmed/skipped decision across re-runs: leave the existing
    // match untouched rather than re-detecting and overwriting it.
    if (row.match_status === "confirmed" || row.match_status === "skipped") continue;

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

    // Through exam_worker_set_match_suggestion, which writes only while this reader holds the
    // message and the batch is still 'matching', and only over an undecided row that does not hold a
    // staff member's pick. The row status the link returned is read before the vision calls, which can
    // take a while: in that time this reader's lease can lapse and another reader finish the batch,
    // staff can confirm, skip or pick a student for this row, and the batch can move to review. A
    // write that only re-checked the row's status in its WHERE clause still replaced a pick (stored
    // as 'suggested' with no confidence) and could land after review opened.
    const written = await setMatchSuggestion(admin, fence, batch.id, scannedId, {
      detectedName: detectedName ?? null,
      detectedSisId: detectedSisId ?? null,
      matchedProfileId: match.profile_id,
      confidence: match.confidence
    });
    if (written === "not_owner") throw new NotOwnerError(`batch ${batch.id}: match message taken over`);
    if (written === "state_changed") return ACK;
  }

  // Conditional transition. A large match job can outlast the 120s visibility window, so a
  // duplicate worker may still be running this after staff have finalized the batch -- an
  // unconditional write would then stamp 'review' over 'completed' or 'error', hiding the
  // terminal result. Only advance from the states that precede review.
  if ((await setBatchStatus(admin, fence, batch.id, "review", REVIEW_FROM)) === "not_owner") {
    throw new NotOwnerError(`batch ${batch.id}: match message taken over`);
  }
  return ACK;
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
async function maybeCompleteBatch(admin: Admin, batchId: number, fence: Fence): Promise<void> {
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
    // Only from finalizing: a finalize left over from a run Retry reopened must not complete (and so
    // freeze) a batch whose undecided rows are back under review.
    if ((await setBatchStatus(admin, fence, batchId, "completed", COMPLETED_FROM)) === "not_owner") {
      throw new NotOwnerError(`batch ${batchId}: finalize message taken over`);
    }
  }
}

async function finalize(
  admin: Admin,
  classId: number,
  batchId: number,
  args: FinalizeArgs,
  fence: Fence
): Promise<void> {
  const provider = getExamVisionProvider();
  const { data: scanned, error } = await admin
    .from("exam_scanned_submissions")
    .select("id, class_id, exam_id, batch_id, matched_profile_id, match_status, submission_id, finalized_at")
    .eq("id", args.scanned_submission_id)
    .single();
  if (error || !scanned) throw new Error(`scanned submission ${args.scanned_submission_id} not found`);

  // Already finalized -> idempotent no-op, regardless of the current match_status (a
  // confirmation may have been changed after this message was enqueued). Still re-check
  // batch completion so a crash in that last step can't strand the batch.
  if (scanned.finalized_at) {
    await maybeCompleteBatch(admin, scanned.batch_id, fence);
    return;
  }

  // Not (or no longer) a confirmed match -> idempotent skip, not an error. enqueue_exam_finalize
  // only queues confirmed submissions, so reaching here means the decision changed after the
  // message was enqueued; throwing would needlessly DLQ the message and error the batch.
  if (scanned.match_status !== "confirmed" || !scanned.matched_profile_id) {
    return;
  }
  const profileId = scanned.matched_profile_id as string;

  // Scan ownership is judged against the batch this message was enqueued for, whose class the
  // enqueue RPC checked the caller against. The scanned row's own batch_id is staff-writable and
  // not tied to its class, so a scope read from it could name another course's batch (#1078).
  // The row, the batch and the copy destination (this class) must all be the same course.
  if (scanned.batch_id !== batchId || scanned.class_id !== classId) {
    throw new ScanPathRejectedError(
      `scanned submission ${scanned.id} is no longer in batch ${batchId} of class ${classId}; refusing to read its scans`
    );
  }
  const scanScope = await loadScanScope(admin, batchId);
  if (scanScope.classId !== classId) {
    throw new ScanPathRejectedError(`batch ${batchId} is not in class ${classId}; refusing to read its scans`);
  }
  // The row's exam_id is staff-writable too, and exam_create_submission takes the assignment from
  // it: a row moved to another exam would file this batch's scans under that exam's assignment.
  if (scanned.exam_id !== scanScope.examId) {
    throw new ScanPathRejectedError(
      `scanned submission ${scanned.id} names exam ${scanned.exam_id}, but batch ${batchId} is exam ${scanScope.examId}; refusing to read its scans`
    );
  }

  // Load and check the pages before creating the submission, so a rejected page leaves no
  // submission or grading review behind (#1078). Every read below uses this validated array;
  // nothing re-queries image_path.
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
    throw new Error(`scanned submission ${scanned.id} has no scan pages; refusing to finalize an empty exam artifact`);
  }
  // Check every page's image path before copying or structuring from any of them (#1078).
  for (const p of pages) assertScanPathInScope(p.image_path, scanScope, `scan page ${p.id}`);
  // Line the pages up with the template as it is now, before creating anything. Staff can replace
  // the template between match and finalize, so a page that no longer lines up refuses the batch
  // before anything is created (#1292).
  const [groupPages] = requireAligned(batchId, [pages], await loadTemplates(admin, scanScope), (p) => p.ocr_data);

  // Create the submission (fires submissions_after_insert_hook -> grading review).
  // exam_create_submission is idempotent: it returns the existing submission_id if the
  // row already exists, so a retried finalize reuses the same submission. Everything below
  // (storage keys, file rows, the artifact) is written under profileId, so the RPC is told
  // which student this read found and refuses if the match changed since (#1270); the
  // retry then reads the row again.
  const { data: subId, error: rpcErr } = await admin.rpc("exam_create_submission", {
    p_scanned_submission_id: scanned.id,
    p_expected_profile_id: profileId
  });
  if (rpcErr || !subId) throw new Error(`exam_create_submission failed: ${rpcErr?.message}`);
  const submissionId = subId as number;

  // Build the submission's files + artifact, then stamp finalized_at. We only reach here
  // when finalized_at is NULL; every step below is idempotent so a resumed finalize (after
  // a crash) re-runs them safely. pageBytes fetches each page image at most once.
  {
    const pageBytes = new Map<string, Promise<Uint8Array>>();

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
      .select(FINALIZE_ANSWER_REGION_SELECT)
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
      // Read the region as drawn, against this scan's words moved into template space. `rect` is
      // where the region sits on the scan, for the model and the grader's crop.
      const drawn: NormRect = { x: r.x, y: r.y, width: r.width, height: r.height };
      const ocrText = wordsInRegion(wordsToTemplate(ocrWords(page.ocr_data), page.reg), drawn);
      const rect = mapRectToScan(drawn, page.reg);
      let structuredValue: unknown = ocrText;
      const question = r.exam_questions as unknown as { answer_type: string | null; label: string | null } | null;
      const answerType = question?.answer_type ?? null;
      // The instructor's name for the question (#1072). Carried into the artifact because the
      // grader view has nothing else to show: it had only exam_question_id, which is a database
      // id, so headings read "Question 38" for a question the instructor called Q1.
      const label = question?.label?.trim() || null;
      if (answerType && answerType !== "free_text" && ocrText) {
        try {
          const bytes = await downloadImageCached(admin, pageBytes, "exam-scans", page.image_path);
          const img: PageImage = { name: page.image_path, bytes, width: page.width ?? 0, height: page.height ?? 0 };
          const structured = await provider.structureAnswer(answerType, img, rect, ocrText);
          structuredValue = structured.value;
        } catch (structureErr) {
          // A bare catch treated a rate limit, a 5xx, a timeout or a reset connection as "this
          // answer cannot be structured": the raw OCR string was substituted, the artifact
          // written, and finalized_at stamped -- permanently degrading a gradeable answer that
          // the worker's own backoff would have recovered (#1077). Retryable provider failures
          // propagate to the dispatcher (rate limits to its rate-limit path, the rest to its
          // transient-error backoff); the fallback is reserved for genuinely unstructurable
          // content (e.g. illegible handwriting).
          if (structureErr instanceof ProviderRateLimitError || structureErr instanceof ProviderTransientError) {
            throw structureErr;
          }
          // fall back to raw OCR text on structuring failure
        }
      }
      questions.push({
        exam_question_id: r.exam_question_id,
        label,
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

  await maybeCompleteBatch(admin, scanned.batch_id, fence);
}

// ---------------------------------------------------------------------------
// Dispatch one message
// ---------------------------------------------------------------------------
async function processMessage(admin: Admin, msg: QueueMessage, scope: Sentry.Scope): Promise<void> {
  const env = msg.message;
  scope.setTag("exam_method", env.method);
  scope.setTag("batch_id", String(env.batch_id));
  // #1293: every captureException below is a give-up. This says whether the budget ran out on the
  // first failure or the sixth, which is the difference between a hard failure and a provider
  // having a bad few minutes -- the context the per-retry events used to carry before they stopped
  // being sent. One exception (#1158): a reader that was taken over captures before giveUp finds
  // that out and leaves the batch, the DLQ and the message to the new holder, which carries on.
  scope.setTag("attempt", String((env.retry_count ?? 0) + 1));
  const fence: Fence = { msgId: msg.msg_id, readCt: msg.read_ct };

  // A message that used up its budget errors its batch, goes to the DLQ and is archived, all in one
  // transaction and only while this reader holds it (giveUpMessage). If another reader holds it
  // now, everything is left to that reader: it is running the same work.
  const giveUp = async (error: unknown, from: readonly BatchStatus[] = errorFrom(env.method)) => {
    if ((await giveUpMessage(admin, fence, env, env.batch_id ?? null, from, error)) === "not_owner") {
      console.warn(`exam-async-worker: msg ${msg.msg_id} was taken over; leaving its failure to the new holder`);
    }
  };

  // poison-pill protection
  if (msg.read_ct >= PGMQ_MAX_READ_CT) {
    const err = new Error(`read_ct=${msg.read_ct} exceeded max — DLQ`);
    Sentry.captureException(err, scope);
    await giveUp(err);
    return;
  }

  let next: Disposition;
  try {
    // env.args is narrowed by env.method (discriminated ExamAsyncEnvelope) — no casts needed.
    if (env.method === "process_page") {
      await processPage(admin, env.batch_id, env.args);
      next = ACK;
    } else if (env.method === "match") {
      next = await doMatch(admin, env, env.args, fence, {
        readDbMs: Date.parse(msg.vt) - READ_VISIBILITY_SECONDS * 1000,
        enqueuedAtMs: Date.parse(msg.enqueued_at)
      });
    } else if (env.method === "finalize") {
      await finalize(admin, env.class_id, env.batch_id, env.args, fence);
      next = ACK;
    } else {
      throw new Error(`unknown method ${(env as { method: string }).method}`);
    }
  } catch (error) {
    if (error instanceof NotOwnerError) {
      // Another reader holds this message now; it re-queues, dead-letters or acknowledges it. This
      // reader stops here. Writes it made earlier in the handler stay, and rely on their own guards.
      console.warn(
        `exam-async-worker: ${error.message} (msg ${msg.msg_id}); stopping, leaving the message to its holder`
      );
      return;
    }
    if (error instanceof ScanPathRejectedError) {
      // A rejected scan path rejects again on every retry, so surface it on the batch now
      // instead of after five retries. Through giveUp, so a reader that lost the message leaves
      // the batch, the DLQ and the message to the one that holds it. A rejection is shown on the
      // batch whatever phase it is in (not only this message's), except over 'completed' (#1078).
      Sentry.captureException(error, scope);
      await giveUp(error, REJECTED_SCAN_ERROR_FROM);
      return;
    }
    if (error instanceof ProviderRateLimitError) {
      // Rate limits are transient, but bound the retries (see MAX_RATE_LIMIT_RETRIES) so a
      // permanently-exhausted quota can't requeue forever.
      if ((env.retry_count ?? 0) >= MAX_RATE_LIMIT_RETRIES) {
        Sentry.captureException(error, scope);
        await giveUp(error);
        return;
      }
      // requeue this message with the provider's backoff, in place of the current copy.
      // This path never captured, so #1293 changes nothing here beyond making the retry visible
      // in the logs the same way the transient path below now is. Logged separately from that
      // one because a run full of rate limits means the quota is too small, while a run full of
      // transient errors means the provider is unwell, and those want different responses.
      log(
        `rate-limit retry ${(env.retry_count ?? 0) + 1} for ${env.method} ` +
          `(batch ${env.batch_id}) in ${error.retryAfterSeconds}s`
      );
      next = retryOf(env, error.retryAfterSeconds);
      await dispose(admin, fence, env, next);
      return;
    }
    const retryCount = env.retry_count ?? 0;
    if (retryCount >= 5) {
      Sentry.captureException(error, scope);
      await giveUp(error);
      return;
    }
    // transient: requeue with exponential backoff
    //
    // #1293: deliberately no captureException. Reaching here is the backoff working, not a
    // failure -- the message is requeued and the next attempt usually succeeds. #1132 made
    // transient provider failures propagate here instead of being swallowed, so capturing meant a
    // 200-student finalize (about 1800 provider calls) could raise hundreds of Sentry events for
    // a condition handled correctly and silently, burying the give-up paths above that actually
    // need triage.
    //
    // The retry stays observable without them: this line makes the rate queryable in the function
    // logs, and the `attempt` tag set at the top of this function tells any event that IS captured
    // how many tries the message had already used.
    const delay = Math.min(300, 10 * Math.pow(2, retryCount));
    log(
      `retry ${retryCount + 1} for ${env.method} (batch ${env.batch_id}) in ${delay}s: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    next = retryOf(env, delay);
  }
  // Outside the try: a re-queue that fails throws to runBatch (the original then comes back), rather
  // than being treated as a handler failure and re-queued again.
  await dispose(admin, fence, env, next);
}

// The re-queued copy for a retry: the same (method, args) pairing, one more retry spent.
function retryOf(env: ExamAsyncEnvelope, delaySeconds: number): Disposition {
  return {
    kind: "requeue",
    message: { ...env, retry_count: (env.retry_count ?? 0) + 1 },
    delaySeconds,
    countWait: false
  };
}

// One message per read. A read starts the 120s visibility window, and messages are handled one
// after another, so reading 5 at once started the clock on 4 that were still waiting their turn.
// Behind slow provider calls those reappeared while still queued and a concurrent invocation ran
// them a second time, and a killed isolate stranded all 5 for the full window (#1158). With one
// message per read, each window starts when that message's work starts. The cost: overlapping
// invocations now split even a small batch, so `match` is more often claimed while its pages are
// still in OCR, and it then waits OCR_WAIT_SECONDS before trying again (see doMatch).
const READ_VISIBILITY_SECONDS = 120;
// When to stop claiming new messages is in claimWindow.ts: until the isolate is near its hard
// lifetime, so a claimed message still has its read window before the kill, and for at least 60s.
// This bounds claims, not runtime: a message that itself outlasts the reserve is still killed.
// Unclaimed messages stay visible, and the cron starts more invocations every minute while the
// queue is non-empty.
// The same per-invocation cap as the previous 50 reads of 5.
const MAX_MESSAGES_PER_INVOCATION = 250;
// The lease on the running message (LEASE_SECONDS, renewed until released) is in
// ../_shared/examWorkerLease.ts, with its tests.

// Whether this isolate has seen the database contract it needs (examWorkerFence.ts). Cached once
// true: a deployed migration does not go away. Never cached false, so a worker that started before
// its migration picks up as soon as the migration lands.
let contractReady = false;
// A closed gate stops every exam batch, so it is reported to Sentry, once per isolate (the cron
// starts several invocations a minute), as well as logged on every invocation.
let contractGapReported = false;

// Why a message body can't be handled, or null if it can. Checks only what every later path relies
// on: an object (else every attempt threw before the poison-pill guard could see it), whose batch_id
// is an integer (give-up passes it to a bigint parameter, so anything else made the give-up itself
// fail and the message came back every READ_VISIBILITY_SECONDS forever), and whose method is a
// string (the logs, the Sentry tag and the dispatch all print it, and an object that can't be
// printed threw there before the message could reach give-up). Every producer is a SQL function
// that writes a string method and an integer batch_id. An unknown method or bad args still fail
// into give-up as before. The reason names types only, never content: it goes to Sentry and the DLQ.
function envelopeProblem(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return `body is ${body === null ? "null" : Array.isArray(body) ? "an array" : `a ${typeof body}`}`;
  }
  const { batch_id: batchId, method } = body as { batch_id?: unknown; method?: unknown };
  if (!Number.isSafeInteger(batchId)) return `batch_id is not an integer (${typeof batchId})`;
  return typeof method === "string" ? null : `method is not a string (${typeof method})`;
}

async function runBatch(): Promise<number> {
  const scope = new Sentry.Scope();
  scope.setTag("function", "exam-async-worker");
  const startedAt = Date.now();
  const admin = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let processed = 0;
  // Counted separately because `processed` is incremented outside the try below, so it is really
  // an attempt count. Reporting the two as one number would have the completion line claim work
  // that threw and was left queued for redelivery, which is the opposite of what #1157 is for.
  let failed = 0;
  const claimUntil = claimDeadlineMs(
    ISOLATE_STARTED_AT_MS,
    startedAt,
    isolateLifetimeMs(Deno.env.get("EDGE_WORKER_TIMEOUT_MS"))
  );
  // Printed with the claim budget, so a run that stops claiming early is visibly a short budget
  // (an old isolate) rather than an empty queue.
  log(`run start: claiming for up to ${Math.round((claimUntil - startedAt) / 1000)}s`);
  // The chart does not order the migrations Job and the edge rollout. A worker that runs before its
  // migration must not fall back to writes without the claim check, so it claims nothing: messages
  // stay queued and visible, and old workers (or this one, once the migration lands) take them.
  if (!contractReady) {
    let status: Awaited<ReturnType<typeof contractStatus>>;
    try {
      status = await contractStatus(admin);
    } catch (error) {
      console.error(
        `[exam-async-worker] database contract check failed: ${error instanceof Error ? error.message : String(error)}`
      );
      Sentry.captureException(error, scope);
      log(`run done: 0 message(s) attempted, 0 failed, in ${Date.now() - startedAt}ms`);
      return 0;
    }
    if (!status.ready) {
      console.warn(`[exam-async-worker] ${status.reason}; not claiming until the migration is applied`);
      if (!contractGapReported) {
        contractGapReported = true;
        Sentry.captureMessage(`exam-async-worker is not claiming: ${status.reason}`, {
          level: "warning",
          tags: { function: "exam-async-worker" }
        });
      }
      log(`run done: 0 message(s) attempted, 0 failed, in ${Date.now() - startedAt}ms`);
      return 0;
    }
    contractReady = true;
  }
  while (processed < MAX_MESSAGES_PER_INVOCATION && Date.now() < claimUntil) {
    const { data, error } = await admin.schema("pgmq_public").rpc("read", {
      queue_name: QUEUE,
      sleep_seconds: READ_VISIBILITY_SECONDS,
      n: 1
    });
    if (error) {
      // Logged as well as captured. A failed read leaves `processed` where it was, so without this
      // line the run is indistinguishable from an idle one, which is the misreading that cost an
      // evening on #814.
      console.error(`[exam-async-worker] queue read failed after ${processed} message(s): ${error.message}`);
      Sentry.captureException(error, scope);
      break;
    }
    const msg = ((data ?? []) as QueueMessage[])[0];
    if (!msg) {
      // What the read returned, not the queue's depth (#1157): reads are one message each (#1158),
      // so an idle worker prints this straight after "run start", and a backed-up one prints a
      // "handling" line per message first.
      log("read 0 message(s)");
      break;
    }
    // processMessage handles its own errors, but it can throw on the way out: a re-queue or give-up
    // that cannot be written throws (deliberately, so the original is not archived without its
    // replacement or its dead-letter record). Catch it so the drain carries on. Nothing is lost: the
    // message reappears when its visibility window lapses.
    try {
      // read_ct counts reads, so above 1 an earlier read of this message ended without a disposition:
      // that reader died, its lease lapsed while it may still be running (see holdLease), it threw
      // on the way out (see the catch below), or its ack failed. A log line only, not a Sentry
      // event; the poison-pill guard in processMessage reports repeat cases.
      // Checked before anything prints the body's fields: a field that can't be printed would throw
      // in the log line, before the message could reach give-up.
      const problem = envelopeProblem(msg.message);
      if (msg.read_ct > 1) {
        console.warn(
          `exam-async-worker redelivery: msg ${msg.msg_id} read_ct=${msg.read_ct}` +
            (problem === null ? ` method=${msg.message.method} batch=${msg.message.batch_id}` : "")
        );
      }
      if (problem !== null) {
        log(`handling malformed msg_id=${msg.msg_id} read_ct=${msg.read_ct}`);
        // The DLQ record keeps the body; the error, which also goes to Sentry, does not.
        const err = new Error(`msg ${msg.msg_id} has no usable envelope (${problem}) — DLQ`);
        Sentry.captureException(err, scope.clone());
        await giveUpMessage(admin, { msgId: msg.msg_id, readCt: msg.read_ct }, msg.message, null, [], err);
        processed++;
        continue;
      }
      const releaseLease = await holdLease(admin, QUEUE, msg);
      if (!releaseLease) {
        // The first lease call found the message no longer ours (archived, or read again after our
        // read window). Running the handler would spend provider calls on work this reader cannot
        // complete or hand off.
        log(`skipping msg_id=${msg.msg_id}: no longer held at the first lease call`);
        processed++;
        continue;
      }
      try {
        // Printed before the handler runs, so a message that kills the isolate still leaves its
        // own name in the log. read_ct is here because a climbing one is the shape of a poison
        // pill.
        const env = msg.message;
        log(
          `handling ${env.method} msg_id=${msg.msg_id} batch=${env.batch_id} read_ct=${msg.read_ct}` +
            (typeof env.debug_id === "string" ? ` debug_id=${env.debug_id}` : "")
        );
        await processMessage(admin, msg, scope.clone());
      } catch (error) {
        // A message whose handler threw comes back after the read window, as it did before the
        // lease. Coming back after LEASE_SECONDS would spend the poison-pill budget in minutes.
        await releaseLease(READ_VISIBILITY_SECONDS);
        throw error;
      }
      // An ack that failed (logged in dispose) leaves the message to come back within
      // LEASE_SECONDS, not READ_VISIBILITY_SECONDS. Handlers tolerate the duplicate.
      await releaseLease();
    } catch (error) {
      Sentry.captureException(error, scope.clone());
      console.error(`processMessage failed for msg ${msg.msg_id}; leaving it queued for redelivery`, error);
      failed++;
    }
    processed++;
  }
  log(`run done: ${processed} message(s) attempted, ${failed} failed, in ${Date.now() - startedAt}ms`);
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
  // Printed before the work is handed to the runtime, and deliberately paired with runBatch's own
  // "run done" line. An invocation that prints this and never prints that one had its isolate
  // reclaimed mid-flight, which is otherwise invisible: the 200 has already gone out.
  //
  // No source label. The obvious one is attractive and does not work: nothing sends
  // x-invocation-source, and the cron job and all three triggers in exam_grading.sql send
  // x-supabase-webhook-source: exam-async-worker, the same value for every one of them, so it
  // cannot separate a cron tick from a trigger either. Telling the callers apart means changing
  // what they send, which is a migration, and this change's rollback is a revert.
  log("invocation accepted; work continues in waitUntil");
  EdgeRuntime.waitUntil(runBatch());
  return Promise.resolve(
    new Response(JSON.stringify({ message: "exam-async-worker started" }), {
      headers: { "Content-Type": "application/json" }
    })
  );
});
