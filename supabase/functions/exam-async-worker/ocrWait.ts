/**
 * How long `match` waits for its batch's OCR before it errors the batch (#1158).
 *
 * A plain-TS module (no Deno or Node imports) so the worker and the Jest test read the same rule
 * (the batchTransitions.ts pattern).
 *
 * Each wait re-queues `match` as a new message, and pgmq reads the oldest visible message first, so
 * a wait lasts until a reader reaches it: about OCR_WAIT_SECONDS while invocations are draining the
 * batch, a cron tick once they have exited, and longer behind another batch's backlog. A page that
 * is retrying a provider error is re-queued the same way, so it can sit behind that backlog too.
 *
 * Before #1158 the limit was 30 waits of at least 30s. Waits are now 5s, so a count alone would be
 * a few minutes, and wall time alone would not stretch behind a backlog the way 30 waits did. The
 * limit is therefore both: at least 30 waits AND at least 15 minutes. That is never sooner than the
 * old limit: about 15 minutes while the batch is draining, and 30 waits however long each takes.
 */
export const MAX_OCR_WAITS = 30;
export const MAX_OCR_WAIT_MS = 15 * 60 * 1000;

/** True once `match` has waited long enough that missing OCR is a failure, not a slow batch. */
export function ocrWaitExhausted(waits: number, waitedMs: number): boolean {
  return waits >= MAX_OCR_WAITS && waitedMs >= MAX_OCR_WAIT_MS;
}
