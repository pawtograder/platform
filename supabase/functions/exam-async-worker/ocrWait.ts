/**
 * When `match` stops waiting for its batch's OCR and errors the batch (#1158).
 *
 * A plain-TS module (no Deno or Node imports) so the worker and the Jest test read the same rule
 * (the batchTransitions.ts pattern).
 *
 * Each wait re-queues `match` as a new message, and pgmq reads the oldest visible message first, so
 * a wait lasts until a reader reaches it: a few seconds while invocations are draining the batch, a
 * cron tick once they have exited, and longer behind another batch's backlog.
 *
 * Before #1158 every wait re-queued with a 30s delay and the 31st read errored the batch. pgmq sets
 * a message's visibility from clock_timestamp() when it is sent, so wait k+1 was counted by the
 * first read at or after S_k + 30s, where S_k is the database time the previous replacement was
 * sent. Waits are now 5s, so the batch reaches review soon after OCR finishes, and only some reads
 * count toward the limit:
 *
 * - A read that counts re-queues with exam_worker_requeue(..., p_count_wait => true), which stamps
 *   the replacement with ocr_wait_from: the same clock_timestamp() its own visibility is computed
 *   from, taken after the claim lock. That is S_k, at or after the moment the old worker would have
 *   sent its replacement.
 * - A later read counts only if it happened at least OCR_WAIT_COUNT_MS + OCR_WAIT_GUARD_MS after
 *   that stamp. Its time is the read's own clock_timestamp() (pgmq.read sets vt to it plus the read
 *   window). Both sides are database time, so the worker's clock never enters into it. The 1s
 *   guard covers the microseconds between the read's WHERE and UPDATE clock readings, so a read the
 *   old rule could not yet have made is never counted.
 * - A re-queue that does not count carries ocr_wait_from forward unchanged.
 *
 * What this guarantees on its own: the batch errors only after 30 counted waits, each at least 31s
 * of database time after the previous counted re-queue, so never sooner than 15.5 minutes after the
 * first (staging's floor was 15). With idle readers a wait counts every 31-36s, so the limit is about
 * 15.5-18 minutes; with readers arriving less often it is later.
 *
 * Compared with staging under the same arrival of readers, counted read k+1 is no earlier than the
 * old rule's read k+1 as long as (1) this re-queue's stamp falls at most 1s (the guard) sooner after
 * its read than the old worker's send did, and (2) the old replacement committed within its 30s
 * delay, or this one commits no sooner after its read than the old one did. A replacement is read
 * only once it is committed and its delay has passed. The old send was a call of its own that
 * committed as it sent, so (2) held unless a commit stalled for over 30s. (1) holds in practice:
 * this re-queue comes later (the worker takes its lease before the handler runs, and the re-queue
 * takes the claim lock). Neither is enforced. Past them a counted read can fall on an earlier
 * reader: with a reader every 31.5s and the re-queue 1.5s sooner, the limit comes after about half
 * the time. The floor above holds either way. Re-parked messages get new msg_ids and sit further
 * back in the queue, which can only delay them.
 *
 * Messages already queued when this deploys carry no ocr_wait_from. One with ocr_waits >= 1 was
 * re-queued by an older worker; its enqueued_at (now() of that send, no later than its
 * clock_timestamp()) is used as the boundary, which errs late, never early.
 */
export const MAX_OCR_WAITS = 30;
export const OCR_WAIT_COUNT_MS = 30_000;
export const OCR_WAIT_GUARD_MS = 1_000;

export type OcrWaitStep = { exhausted: true } | { exhausted: false; waits: number; counted: boolean };

/**
 * The database time of the last counted wait, or undefined before the first. `ocrWaitFrom` is the
 * envelope's ocr_wait_from; `enqueuedAtMs` is this message's enqueued_at, used for a message an
 * older worker re-queued.
 */
export function ocrWaitBoundaryMs(
  waits: number,
  ocrWaitFrom: string | undefined,
  enqueuedAtMs: number
): number | undefined {
  if (ocrWaitFrom !== undefined) {
    const t = Date.parse(ocrWaitFrom);
    if (Number.isFinite(t)) return t;
  }
  return waits >= 1 ? enqueuedAtMs : undefined;
}

/**
 * What a read of a waiting `match` message does. `waits` is the number of counted waits so far,
 * `boundaryMs` the last counted one (ocrWaitBoundaryMs), `readDbMs` this read's database time.
 * - Too soon after the boundary: only re-queue; nothing is counted.
 * - Otherwise this read counts: with MAX_OCR_WAITS already counted the wait is over (error the
 *   batch); else count it and re-queue with the stamp.
 */
export function nextOcrWait(waits: number, boundaryMs: number | undefined, readDbMs: number): OcrWaitStep {
  if (boundaryMs !== undefined && readDbMs - boundaryMs < OCR_WAIT_COUNT_MS + OCR_WAIT_GUARD_MS) {
    return { exhausted: false, waits, counted: false };
  }
  if (waits >= MAX_OCR_WAITS) return { exhausted: true };
  return { exhausted: false, waits: waits + 1, counted: true };
}
