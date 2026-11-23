/**
 * Pure helpers for the `exams.*` CLI commands. No Deno or Supabase imports, so
 * Jest can load this file directly.
 */

export interface ExamQuestionRow {
  id: number;
  parent_id: number | null;
  level: number;
  ordinal: number;
  label: string | null;
  points: number | null;
  answer_type: string | null;
}

export interface ExamRubricCheckRow {
  id: number;
  name: string;
  points: number;
  rubric_id: number;
  exam_question_id: number | null;
}

interface QuestionCheckRow {
  question_id: number;
  parent_id: number | null;
  level: number;
  label: string | null;
  /** Labels from the top-level question down to this one, e.g. "Q1 > a". */
  path: string;
  points: number | null;
  answer_type: string | null;
  rubric_checks: Array<{ id: number; name: string; points: number }>;
}

/**
 * Each question in tree order (parent first, siblings by ordinal), with the
 * grading-rubric checks linked to it. A question with no check is kept, with
 * an empty list, so the operator can see which questions have nothing to grade
 * against. A question whose parent is missing comes after the rest.
 */
export function questionCheckRows(
  questions: ExamQuestionRow[],
  checks: ExamRubricCheckRow[],
  gradingRubricId: number | null
): QuestionCheckRow[] {
  const checksByQuestion = new Map<number, ExamRubricCheckRow[]>();
  for (const check of checks) {
    if (check.exam_question_id == null || check.rubric_id !== gradingRubricId) continue;
    const list = checksByQuestion.get(check.exam_question_id) ?? [];
    list.push(check);
    checksByQuestion.set(check.exam_question_id, list);
  }

  const ids = new Set(questions.map((q) => q.id));
  const childrenOf = new Map<number | null, ExamQuestionRow[]>();
  for (const q of questions) {
    const key = q.parent_id != null && ids.has(q.parent_id) ? q.parent_id : null;
    const siblings = childrenOf.get(key) ?? [];
    siblings.push(q);
    childrenOf.set(key, siblings);
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.ordinal - b.ordinal || a.id - b.id);

  const rows: QuestionCheckRow[] = [];
  const visit = (q: ExamQuestionRow, parentPath: string | null) => {
    const own = q.label ?? `#${q.id}`;
    const path = parentPath ? `${parentPath} > ${own}` : own;
    rows.push({
      question_id: q.id,
      parent_id: q.parent_id,
      level: q.level,
      label: q.label,
      path,
      points: q.points,
      answer_type: q.answer_type,
      rubric_checks: (checksByQuestion.get(q.id) ?? [])
        .sort((a, b) => a.id - b.id)
        .map((c) => ({ id: c.id, name: c.name, points: c.points }))
    });
    for (const child of childrenOf.get(q.id) ?? []) visit(child, path);
  };
  for (const q of childrenOf.get(null) ?? []) visit(q, null);
  return rows;
}

interface BatchSummary {
  status: string;
  error: string | null;
  total_pages: number;
  pages_per_exam: number;
  pages_uploaded: number;
  /** False when fewer pages are stored than the batch claims; processing will refuse it. */
  upload_complete: boolean;
  scanned_exams: number;
  matches: { unmatched: number; suggested: number; confirmed: number; skipped: number };
  submissions_created: number;
}

/** What `exams scans status` reports for one batch. */
export function summarizeBatch(
  batch: { status: string; error: string | null; total_pages: number; pages_per_exam: number },
  pagesUploaded: number,
  scanned: Array<{ match_status: string; finalized_at: string | null }>
): BatchSummary {
  const matches = { unmatched: 0, suggested: 0, confirmed: 0, skipped: 0 };
  for (const row of scanned) {
    if (Object.hasOwn(matches, row.match_status)) matches[row.match_status as keyof typeof matches]++;
  }
  return {
    status: batch.status,
    error: batch.error,
    total_pages: batch.total_pages,
    pages_per_exam: batch.pages_per_exam,
    pages_uploaded: pagesUploaded,
    upload_complete: pagesUploaded === batch.total_pages,
    scanned_exams: scanned.length,
    matches,
    submissions_created: scanned.filter((row) => row.finalized_at != null).length
  };
}

/**
 * Why `pagesPerExam` can't be used with a template of `templatePages` pages, or null if it can.
 * A template of 0 pages has not been rasterized, so there is nothing to compare against; this is
 * the rule enqueue_exam_process_batch enforces, checked before anything is uploaded.
 */
export function pagesPerExamError(templatePages: number, pagesPerExam: unknown): string | null {
  if (typeof pagesPerExam !== "number" || !Number.isInteger(pagesPerExam) || pagesPerExam < 1) {
    return "pages_per_exam must be a positive integer";
  }
  if (templatePages > 0 && pagesPerExam !== templatePages) {
    return (
      `This exam's template has ${templatePages} page(s), but the scan is set to ${pagesPerExam} ` +
      `page(s) per exam. Set pages-per-exam to ${templatePages} before uploading.`
    );
  }
  return null;
}

/**
 * Why a scan of `totalPages` pages can't be split into exams of `pagesPerExam`, or null if it can.
 * The exam worker refuses an uneven batch after OCR, so this refuses it before anything is uploaded.
 */
export function unevenPagesError(totalPages: number, pagesPerExam: number): string | null {
  if (totalPages % pagesPerExam === 0) return null;
  return (
    `The scan has ${totalPages} page(s), which is not a multiple of ${pagesPerExam} page(s) per exam. ` +
    `Re-scan it or check the PDF for a missing or extra page.`
  );
}

/**
 * Why a batch in `status` can't be processed, or null if it can. The Scans page only offers
 * Process for these two states; the RPC has no status guard, so re-processing a completed batch
 * would send it back to review.
 */
export function processBatchError(status: string): string | null {
  if (status === "uploaded" || status === "error") return null;
  return `Batch is ${status}; only an uploaded or errored batch can be processed`;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk, or null if `bytes` is not a PNG. */
export function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/**
 * Why `pageIndex` can't be a page of a batch of `totalPages` pages, or null if it can. Processing
 * checks only the page COUNT, so a page past the end plus a missing one would pass it and matching
 * would group the wrong pages.
 */
export function pageIndexError(pageIndex: unknown, totalPages: number): string | null {
  if (typeof pageIndex !== "number" || !Number.isInteger(pageIndex) || pageIndex < 0) {
    return "page_index must be a non-negative integer";
  }
  if (pageIndex >= totalPages) return `page_index ${pageIndex} is outside this batch's ${totalPages} page(s)`;
  return null;
}

/**
 * Why a new page can't be added to a batch in `status`, or null if it can. Checked after a retried
 * page is found already stored, so a retry still succeeds once the batch has moved on.
 */
export function addPageError(status: string): string | null {
  if (status === "uploaded") return null;
  return `batch is '${status}'; pages can only be added while it is 'uploaded'`;
}

type FinalizeAction = "create" | "needs_review" | "skipped" | "already_created";

interface FinalizePlanRow {
  scanned_submission_id: number;
  exam_index: number;
  action: FinalizeAction;
  match_status: string;
  profile_id: string | null;
  student_name: string | null;
  page_indexes: number[];
}

function finalizeAction(row: { match_status: string; finalized_at: string | null }): FinalizeAction {
  if (row.finalized_at != null) return "already_created";
  if (row.match_status === "confirmed") return "create";
  if (row.match_status === "skipped") return "skipped";
  return "needs_review";
}

/**
 * What `exams scans finalize` would do for each scanned exam: enqueue_exam_finalize creates a
 * submission for every confirmed exam not yet finalized and leaves the rest. Conflicts (two exams
 * for one student, a student who already has a submission) are left to the RPC, which refuses them.
 */
export function planFinalize(
  scanned: Array<{
    id: number;
    exam_index: number;
    match_status: string;
    matched_profile_id: string | null;
    finalized_at: string | null;
  }>,
  pages: Array<{ page_index: number; scanned_submission_id: number | null }>,
  studentNames: Map<string, string>
): FinalizePlanRow[] {
  const pagesByExam = new Map<number, number[]>();
  for (const page of pages) {
    if (page.scanned_submission_id == null) continue;
    const list = pagesByExam.get(page.scanned_submission_id) ?? [];
    list.push(page.page_index);
    pagesByExam.set(page.scanned_submission_id, list);
  }

  return [...scanned]
    .sort((a, b) => a.exam_index - b.exam_index)
    .map((row) => ({
      scanned_submission_id: row.id,
      exam_index: row.exam_index,
      action: finalizeAction(row),
      match_status: row.match_status,
      profile_id: row.matched_profile_id,
      student_name: row.matched_profile_id ? (studentNames.get(row.matched_profile_id) ?? null) : null,
      page_indexes: (pagesByExam.get(row.id) ?? []).sort((a, b) => a - b)
    }));
}
