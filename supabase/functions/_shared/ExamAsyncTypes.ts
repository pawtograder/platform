// Envelope types for the exam_processing pgmq queue (consumed by exam-async-worker).

export type ExamAsyncMethod = "process_page" | "match" | "finalize";

export type ProcessPageArgs = { scan_page_id: number };
export type MatchArgs = { batch_id: number };
export type FinalizeArgs = { scanned_submission_id: number };

export type ExamAsyncArgs = ProcessPageArgs | MatchArgs | FinalizeArgs;

// `retry_count` is the dispatcher's transient-error budget (5 attempts, exponential backoff)
// and MUST NOT be spent on anything else. `ocr_waits` is counted separately so a match message
// that legitimately parks itself waiting for the process_page fan-out to finish does not eat
// the error budget it would need if a real transient failure happened afterwards.
// `ocr_waits` counts only waits at least 30s apart, and `ocr_wait_from` is the database time the
// last counted one was re-queued, stamped by exam_worker_requeue, so the limit is never reached
// sooner than staging's 30 waits of 30s (exam-async-worker/ocrWait.ts). `ocr_wait_started_ms`
// (epoch ms) is the first wait, for the error message. `ocr_wait_counted_ms` was the previous
// worker-clock boundary; messages that still carry it are read with their enqueued_at instead.
type ExamAsyncMeta = {
  class_id: number;
  batch_id: number;
  retry_count?: number;
  ocr_waits?: number;
  ocr_wait_from?: string;
  ocr_wait_counted_ms?: number;
  ocr_wait_started_ms?: number;
  debug_id?: string;
};

// Discriminated on `method` so an envelope can't pair the wrong args with a method
// (e.g. method "finalize" with MatchArgs); the worker's dispatch narrows args by method.
export type ExamAsyncEnvelope =
  | ({ method: "process_page"; args: ProcessPageArgs } & ExamAsyncMeta)
  | ({ method: "match"; args: MatchArgs } & ExamAsyncMeta)
  | ({ method: "finalize"; args: FinalizeArgs } & ExamAsyncMeta);
