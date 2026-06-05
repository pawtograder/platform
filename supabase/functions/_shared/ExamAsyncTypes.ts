// Envelope types for the exam_processing pgmq queue (consumed by exam-async-worker).

export type ExamAsyncMethod = "process_page" | "match" | "finalize";

export type ProcessPageArgs = { scan_page_id: number };
export type MatchArgs = { batch_id: number };
export type FinalizeArgs = { scanned_submission_id: number };

export type ExamAsyncArgs = ProcessPageArgs | MatchArgs | FinalizeArgs;

export type ExamAsyncEnvelope = {
  method: ExamAsyncMethod;
  class_id: number;
  batch_id: number;
  args: ExamAsyncArgs;
  retry_count?: number;
  debug_id?: string;
};
