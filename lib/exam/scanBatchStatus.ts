/**
 * What each exam_scan_batches.status means to an instructor (#1262, #1269). The values are the
 * column's check constraint (20261107120000_exam_grading.sql). `working` marks the states the
 * worker moves on by itself, which the Scan & Match page shows as in progress and polls.
 */
export type ScanBatchStatus = "uploaded" | "ocr" | "matching" | "review" | "finalizing" | "completed" | "error";

type StatusInfo = { label: string; colorPalette: string; working: boolean };

const SCAN_BATCH_STATUS: Record<ScanBatchStatus, StatusInfo> = {
  uploaded: { label: "Uploaded", colorPalette: "gray", working: false },
  ocr: { label: "Reading pages", colorPalette: "blue", working: true },
  matching: { label: "Matching names", colorPalette: "blue", working: true },
  review: { label: "Needs review", colorPalette: "yellow", working: false },
  finalizing: { label: "Creating submissions", colorPalette: "blue", working: true },
  completed: { label: "Submissions created", colorPalette: "green", working: false },
  error: { label: "Failed", colorPalette: "red", working: false }
};

export function scanBatchStatus(status: string): StatusInfo {
  // An unknown value (a status added later) still renders, as itself, and is not polled.
  return SCAN_BATCH_STATUS[status as ScanBatchStatus] ?? { label: status, colorPalette: "gray", working: false };
}
