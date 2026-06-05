// Envelope types for the exam_processing pgmq queue (consumed by exam-async-worker).

export type ExamAsyncMethod = "process_page" | "match" | "finalize";

export type ProcessPageArgs = { scan_page_id: number };
export type MatchArgs = { batch_id: number };
export type FinalizeArgs = { scanned_submission_id: number };

export type ExamAsyncArgs = ProcessPageArgs | MatchArgs | FinalizeArgs;

type ExamAsyncMeta = { class_id: number; batch_id: number; retry_count?: number; debug_id?: string };

// Discriminated on `method` so an envelope can't pair the wrong args with a method
// (e.g. method "finalize" with MatchArgs); the worker's dispatch narrows args by method.
export type ExamAsyncEnvelope =
  | ({ method: "process_page"; args: ProcessPageArgs } & ExamAsyncMeta)
  | ({ method: "match"; args: MatchArgs } & ExamAsyncMeta)
  | ({ method: "finalize"; args: FinalizeArgs } & ExamAsyncMeta);
