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
// `ocr_wait_started_ms` (epoch ms) is set on the first such wait and carried forward; the worker
// gives up once both the count and the time since then reach their limits
// (exam-async-worker/ocrWait.ts).
type ExamAsyncMeta = {
  class_id: number;
  batch_id: number;
  retry_count?: number;
  ocr_waits?: number;
  ocr_wait_started_ms?: number;
  debug_id?: string;
};

// Discriminated on `method` so an envelope can't pair the wrong args with a method
// (e.g. method "finalize" with MatchArgs); the worker's dispatch narrows args by method.
export type ExamAsyncEnvelope =
  | ({ method: "process_page"; args: ProcessPageArgs } & ExamAsyncMeta)
  | ({ method: "match"; args: MatchArgs } & ExamAsyncMeta)
  | ({ method: "finalize"; args: FinalizeArgs } & ExamAsyncMeta);
