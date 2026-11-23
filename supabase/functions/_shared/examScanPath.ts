// Ownership check for exam scan images (Deno).
//
// exam_scan_pages.image_path is written by staff (lib/exam/examClient.ts uploadExamScanBatch) and
// read by the exam worker with the service role, which bypasses storage RLS. Row RLS only ties the
// page to its batch and class; it says nothing about the object the path names. So without this
// check a grader could point a page at another course's scan and have the worker OCR and copy it
// into their own course (#1078). Every worker read of a scan image goes through
// assertScanPathInScope first, against the batch the page is being processed for.
//
// The uploader's canonical key, and the only shape accepted:
//   classes/{classId}/exams/{examId}/batches/{batchId}/{file}.png

export type ScanScope = { classId: number; examId: number; batchId: number };

/**
 * A scan the worker refuses to read: its image path is malformed or belongs to another class, exam
 * or batch, or (from finalize) its scanned submission no longer matches the batch it was queued
 * for. Not retryable.
 */
export class ScanPathRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanPathRejectedError";
  }
}

// Positive integer ids small enough to round-trip through Number exactly.
const ID = /^[1-9][0-9]{0,14}$/;
// One file name segment: no separators, no leading dot, nothing that needs URL encoding.
const FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.png$/;

/** Parse a canonical exam-scans key into the ids it names, or null if it is not one. */
export function parseScanPath(path: string): ScanScope | null {
  const segments = path.split("/");
  if (segments.length !== 7) return null;
  const [classesLit, classId, examsLit, examId, batchesLit, batchId, file] = segments;
  if (classesLit !== "classes" || examsLit !== "exams" || batchesLit !== "batches") return null;
  if (!ID.test(classId) || !ID.test(examId) || !ID.test(batchId)) return null;
  if (!FILE.test(file) || file.includes("..")) return null;
  return { classId: Number(classId), examId: Number(examId), batchId: Number(batchId) };
}

// A staff-written path as it appears in an error message: quoted, and cut short if long.
function describePath(path: string): string {
  return JSON.stringify(path.length > 200 ? `${path.slice(0, 200)}...` : path);
}

/** Throw unless `path` is a canonical scan key for exactly this class, exam and batch. */
export function assertScanPathInScope(path: string, scope: ScanScope, what: string): void {
  const shown = describePath(path);
  const parsed = parseScanPath(path);
  if (!parsed) {
    throw new ScanPathRejectedError(
      `${what}: image path ${shown} is not a canonical exam scan path; refusing to read it`
    );
  }
  if (parsed.classId !== scope.classId || parsed.examId !== scope.examId || parsed.batchId !== scope.batchId) {
    throw new ScanPathRejectedError(
      `${what}: image path ${shown} does not belong to class ${scope.classId}, exam ${scope.examId}, ` +
        `batch ${scope.batchId}; refusing to read it`
    );
  }
}

// Template pages are staff-written rows too, so the worker reads their images under the same rule
// (#1292). The uploader's key, and the only shape accepted:
//   classes/{classId}/exams/{examId}/template/page-{n}.png
const TEMPLATE_FILE = /^page-[1-9][0-9]{0,4}\.png$/;

/** Parse a canonical exam-templates page key into the ids it names, or null if it is not one. */
export function parseTemplatePath(path: string): { classId: number; examId: number } | null {
  const segments = path.split("/");
  if (segments.length !== 6) return null;
  const [classesLit, classId, examsLit, examId, templateLit, file] = segments;
  if (classesLit !== "classes" || examsLit !== "exams" || templateLit !== "template") return null;
  if (!ID.test(classId) || !ID.test(examId) || !TEMPLATE_FILE.test(file)) return null;
  return { classId: Number(classId), examId: Number(examId) };
}

/** Throw unless `path` is a template page key for exactly this class and exam. */
export function assertTemplatePathInScope(
  path: string,
  scope: { classId: number; examId: number },
  what: string
): void {
  const parsed = parseTemplatePath(path);
  if (!parsed || parsed.classId !== scope.classId || parsed.examId !== scope.examId) {
    throw new ScanPathRejectedError(
      `${what}: image path ${describePath(path)} is not a template page of class ${scope.classId}, ` +
        `exam ${scope.examId}; refusing to read it`
    );
  }
}
