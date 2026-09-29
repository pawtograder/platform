// Replay upload (package 6). See uploadReplay.ts and segments.ts.
export {
  createReplayUpload,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  SEND_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
  resetUploadStateForTests,
  uploadReplay,
  type ReportContextTags,
  type UploadOptions,
  type UploadResult,
  type UploadStats
} from "./uploadReplay";
export {
  deflate,
  MAX_SEGMENT_COMPRESSED_BYTES,
  planSegments,
  recordingPayload,
  type Compressor,
  type DroppedRange,
  type PreparedSegment,
  type SegmentPlan
} from "./segments";
