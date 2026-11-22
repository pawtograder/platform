// Reading scan pages against their template pages (#1292): the stored OCR shape, the template's
// printed words, and lining up a batch's pages. The fitting itself is _shared/examRegistration.ts.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database, Json } from "../_shared/SupabaseTypes.d.ts";
import { assertTemplatePathInScope, ScanPathRejectedError, type ScanScope } from "../_shared/examScanPath.ts";
import { getExamVisionProvider, type WordBox } from "../_shared/examVision.ts";
import { alignPage, type PageWords, type Registration } from "../_shared/examRegistration.ts";
import { downloadImage } from "./storage.ts";

type Admin = SupabaseClient<Database>;

/** What `ocr_data` holds on both exam_scan_pages and exam_template_pages. */
type OcrData = { words: WordBox[] };

export function toOcrData(words: WordBox[]): Json {
  return { words } satisfies OcrData as unknown as Json;
}

/** The words of a stored `ocr_data`, or none for a page not read yet. */
export function ocrWords(ocr: Json | null): WordBox[] {
  return (ocr as OcrData | null)?.words ?? [];
}

/** OCR and store every unread page of this exam's template. */
async function ocrMissingTemplatePages(admin: Admin, scope: { classId: number; examId: number }): Promise<void> {
  const { data, error } = await admin
    .from("exam_template_pages")
    .select("id, page_number, image_path, width, height")
    .eq("exam_id", scope.examId)
    .is("ocr_data", null);
  if (error) throw new Error(`load unread template pages for exam ${scope.examId} failed: ${error.message}`);
  await Promise.all(
    (data ?? []).map(async (t) => {
      assertTemplatePathInScope(t.image_path, scope, `template page ${t.page_number}`);
      const bytes = await downloadImage(admin, "exam-templates", t.image_path);
      const { words } = await getExamVisionProvider().ocrImage({
        name: t.image_path,
        bytes,
        width: t.width,
        height: t.height
      });
      const { error: updErr } = await admin
        .from("exam_template_pages")
        .update({ ocr_data: toOcrData(words) })
        .eq("id", t.id)
        .is("ocr_data", null);
      if (updErr) throw new Error(`persist OCR for template page ${t.page_number} failed: ${updErr.message}`);
    })
  );
}

/**
 * A page that could not be lined up with its template page (#1292). Rescanning is the fix, so the
 * worker dead-letters it at once and shows it on the batch rather than retrying.
 */
export class ScanAlignmentRejectedError extends ScanPathRejectedError {
  constructor(message: string) {
    super(message);
    this.name = "ScanAlignmentRejectedError";
  }
}

/**
 * The printed words of each page of this exam's template, by page number, reading any page that has
 * not been read yet. Finalize needs this as well as match: a batch matched before #1292 deployed, or
 * one whose template was replaced since, has template pages nobody has read.
 */
export async function loadTemplates(admin: Admin, scope: ScanScope): Promise<Map<number, PageWords>> {
  await ocrMissingTemplatePages(admin, scope);
  const { data, error } = await admin
    .from("exam_template_pages")
    .select("page_number, width, height, ocr_data")
    .eq("exam_id", scope.examId);
  if (error) throw new Error(`load template pages for exam ${scope.examId} failed: ${error.message}`);
  // Only a template re-uploaded between the read above and this load. A plain error, so the worker
  // retries and the retry reads the new pages, rather than reading these scans as drawn.
  if ((data ?? []).some((t) => t.ocr_data === null)) {
    throw new Error(`batch ${scope.batchId}: the template was replaced while it was being read`);
  }
  return new Map(
    (data ?? []).map((t) => [t.page_number, { words: ocrWords(t.ocr_data), width: t.width, height: t.height }])
  );
}

type SizedPage = { page_index: number; width: number | null; height: number | null };

/** Stands in for every page of an exam with no template uploaded: nothing to place a scan by. */
const NO_TEMPLATE: PageWords = { words: [], width: 0, height: 0 };

/**
 * Each exam's pages with their registrations, where the i-th page of an exam goes with template
 * page i+1: AS_DRAWN when that template page has nothing printed to place it by, or the exam has no
 * template at all. A page past the template's last page is refused like one that doesn't line up. Throws
 * ScanAlignmentRejectedError naming every page that should have lined up and did not, so no region
 * is ever read from a page that is out of place.
 */
export function requireAligned<P extends SizedPage>(
  batchId: number,
  exams: P[][],
  templates: Map<number, PageWords>,
  ocrOf: (page: P) => Json | null
): (P & { reg: Registration })[][] {
  const aligned: (P & { reg: Registration })[][] = [];
  const misaligned: number[] = [];
  for (const examPages of exams) {
    const exam: (P & { reg: Registration })[] = [];
    examPages.forEach((p, i) => {
      const reg = alignPage(templates.size === 0 ? NO_TEMPLATE : templates.get(i + 1), {
        words: ocrWords(ocrOf(p)),
        width: p.width ?? 0,
        height: p.height ?? 0
      });
      if (reg) exam.push({ ...p, reg });
      else misaligned.push(p.page_index + 1);
    });
    aligned.push(exam);
  }
  if (misaligned.length > 0) {
    const shown =
      misaligned.slice(0, 20).join(", ") + (misaligned.length > 20 ? `, and ${misaligned.length - 20} more` : "");
    throw new ScanAlignmentRejectedError(
      `batch ${batchId}: page${misaligned.length === 1 ? "" : "s"} ${shown} could not be lined up with the template. ` +
        `Check the pages are in order and belong to this exam, rescan them, and run Process again.`
    );
  }
  return aligned;
}

/**
 * Every exam of a batch with its registrations (see requireAligned). The pages' OCR words are loaded here and dropped on return, so match does
 * not hold a large batch's words through the identity reads that follow.
 */
export async function alignBatch<P extends SizedPage & { id: number }>(
  admin: Admin,
  scope: ScanScope,
  exams: P[][]
): Promise<(P & { reg: Registration })[][]> {
  const [templates, ocr] = await Promise.all([loadTemplates(admin, scope), loadBatchOcr(admin, scope.batchId)]);
  return requireAligned(scope.batchId, exams, templates, (p) => ocr.get(p.id) ?? null);
}

async function loadBatchOcr(admin: Admin, batchId: number): Promise<Map<number, Json | null>> {
  const { data, error } = await admin.from("exam_scan_pages").select("id, ocr_data").eq("batch_id", batchId);
  if (error) throw new Error(`load OCR for batch ${batchId} failed: ${error.message}`);
  return new Map((data ?? []).map((p) => [p.id, p.ocr_data]));
}
