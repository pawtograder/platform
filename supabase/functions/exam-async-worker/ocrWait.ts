/**
 * When `match` stops waiting for its batch's OCR and errors the batch (#1158).
 *
 * A plain-TS module (no Deno or Node imports) so the worker and the Jest test read the same rule
 * (the batchTransitions.ts pattern).
 *
 * Each wait re-queues `match` as a new message, and pgmq reads the oldest visible message first, so
 * a wait lasts until a reader reaches it: a few seconds while invocations are draining the batch, a
 * cron tick once they have exited, and longer behind another batch's backlog. A page that is
 * retrying a provider error is re-queued the same way, so it can sit behind that backlog too.
 *
 * Before #1158 a wait was at least 30s (the re-queue delay) and the 31st read errored the batch.
 * Waits are now 5s so the batch reaches review soon after OCR finishes, but only a read at least
 * 30s after the last counted one counts toward the limit. The k-th counted read is then no earlier
 * than the k-th read under the old rule: the old message became visible 30s after its previous read
 * and was taken by the next reader to reach it, and a counted read here is a reader reaching this
 * message at least 30s after the previous counted read. So the batch errors no sooner than before,
 * however the readers are spaced, including behind a partial backlog. With idle readers a wait
 * counts every 30-35s, so the limit is about 15-17.5 minutes, as before.
 */
export const MAX_OCR_WAITS = 30;
export const OCR_WAIT_COUNT_MS = 30_000;

export type OcrWaitStep = { exhausted: true } | { exhausted: false; waits: number; countedMs: number | undefined };

/**
 * What a read of a waiting `match` message does.
 * `waits` is the number of counted waits so far (staging's `ocr_waits`), `countedMs` when the last
 * one was counted (undefined before the first, and on messages queued by a worker that predates
 * this rule, whose previous wait was a 30s one).
 * - A read less than OCR_WAIT_COUNT_MS after the last counted one only re-queues; nothing changes.
 * - Otherwise this read counts: with MAX_OCR_WAITS already counted, the wait is over (error the
 *   batch); else count it and re-queue.
 */
export function nextOcrWait(waits: number, countedMs: number | undefined, nowMs: number): OcrWaitStep {
  if (countedMs !== undefined && nowMs - countedMs < OCR_WAIT_COUNT_MS) {
    return { exhausted: false, waits, countedMs };
  }
  if (waits >= MAX_OCR_WAITS) return { exhausted: true };
  return { exhausted: false, waits: waits + 1, countedMs: nowMs };
}
