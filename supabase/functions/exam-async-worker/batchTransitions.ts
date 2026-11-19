/**
 * Which exam_scan_batches.status values each exam-async-worker write may move a batch from.
 *
 * A plain-TS module (no Deno or Node imports) so the worker and the Jest test read the same table
 * (the finalizeQueries.ts pattern, #1075).
 *
 * The worker can run a message that no longer matches the batch: a copy whose lease lapsed while
 * another reader took it over, a match that outlived its read window, or a finalize left over from
 * a run that Retry reopened (#1158, #1270). Its status writes must then do nothing. Each write goes
 * through exam_worker_set_batch_status, which applies it only while this reader still holds the
 * message AND the batch is in one of the states below, in one transaction.
 *
 * The states come from who moves a batch where:
 * - enqueue_exam_process_batch: uploaded / error -> ocr (then queues process_page and match)
 * - worker match: ocr -> matching -> review
 * - enqueue_exam_finalize: review / error -> finalizing (then queues finalize)
 * - worker finalize: finalizing -> completed
 * - worker, on a message that exhausted its retries: the phase that message belongs to -> error
 */

export type BatchStatus = "uploaded" | "ocr" | "matching" | "review" | "finalizing" | "completed" | "error";

/**
 * match: the batch is before review (staging's MATCHABLE_STATUSES, #1133). Not from review,
 * finalizing, completed or error: a stale match must not move a batch backwards or hide a result.
 */
export const MATCHING_FROM: readonly BatchStatus[] = ["uploaded", "ocr", "matching"];
export const REVIEW_FROM: readonly BatchStatus[] = ["uploaded", "ocr", "matching"];

/**
 * finalize: only a batch whose submissions are being created. A finalize left over from an earlier
 * run must not complete a batch that Retry reopened while undecided rows remain.
 */
export const COMPLETED_FROM: readonly BatchStatus[] = ["finalizing"];

/**
 * A message that exhausted its retries errors the batch only while the batch is in that message's
 * phase. A redelivered process_page after OCR finished, or a leftover finalize after Retry, does not
 * error a batch that has moved on. 'error' itself is excluded so the first failure's message stays.
 */
const ERROR_FROM_BY_METHOD: Record<string, readonly BatchStatus[]> = {
  process_page: ["ocr"],
  match: ["ocr", "matching"],
  finalize: ["finalizing"]
};
const ERROR_FROM_UNKNOWN_METHOD: readonly BatchStatus[] = ["ocr", "matching", "finalizing"];

export function errorFrom(method: string | undefined): readonly BatchStatus[] {
  return (method && ERROR_FROM_BY_METHOD[method]) || ERROR_FROM_UNKNOWN_METHOD;
}

/**
 * A scan the worker rejected (a page or row that names another course, batch or exam, #1078) is
 * shown on its batch at once, whatever phase the batch is in, since the rejection is about the data,
 * not about this message being stale. Never over 'completed': every confirmed exam was finalized
 * from validated pages, so a later rejection describes stale work. Still fenced on the claim.
 */
export const REJECTED_SCAN_ERROR_FROM: readonly BatchStatus[] = [
  "uploaded",
  "ocr",
  "matching",
  "review",
  "finalizing",
  "error"
];

/**
 * exam_worker_set_batch_status's answer.
 * - applied: the write happened.
 * - state_changed: this reader holds the message, but the batch is no longer in an allowed state.
 * - not_owner: another reader holds the message now, or it is gone. Leave every side effect to it.
 */
export type TransitionOutcome = "applied" | "state_changed" | "not_owner";

export function isTransitionOutcome(value: unknown): value is TransitionOutcome {
  return value === "applied" || value === "state_changed" || value === "not_owner";
}
