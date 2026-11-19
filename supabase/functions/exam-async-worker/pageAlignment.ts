// Reading scan pages against their template pages (#1292): the stored OCR shape, the template's
// printed words, and lining up one exam's pages. The fitting itself is _shared/examRegistration.ts.

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

/**
 * OCR and store every page of this exam's template that has not been read yet. Match runs this
 * before aligning a batch, so a template is read the first time one of its batches is matched, and
 * again after a re-upload (which inserts new rows).
 */
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

/** The printed words of each template page that has been read, by page number. */
export async function loadTemplatePages(admin: Admin, examId: number): Promise<Map<number, PageWords>> {
  const { data, error } = await admin
    .from("exam_template_pages")
    .select("page_number, width, height, ocr_data")
    .eq("exam_id", examId)
    .not("ocr_data", "is", null);
  if (error) throw new Error(`load template pages for exam ${examId} failed: ${error.message}`);
  return new Map(
    (data ?? []).map((t) => [t.page_number, { words: ocrWords(t.ocr_data), width: t.width, height: t.height }])
  );
}

type ScanPage = { width: number | null; height: number | null; ocr_data: Json | null };

// A page against the template page of the same position in its exam: AS_DRAWN when that template
// page has nothing printed to place it by, null when the page should have lined up and did not.
function pageRegistration(p: ScanPage, template: PageWords | undefined): Registration | null {
  return alignPage(template, { words: ocrWords(p.ocr_data), width: p.width ?? 0, height: p.height ?? 0 });
}

/** One exam's pages, each with its registration; the i-th page goes with template page i+1. */
export function alignExam<P extends ScanPage>(
  examPages: P[],
  templates: Map<number, PageWords>
): (P & { reg: Registration | null })[] {
  return examPages.map((p, i) => ({ ...p, reg: pageRegistration(p, templates.get(i + 1)) }));
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

type BatchPage = { id: number; page_index: number; width: number | null; height: number | null };

/**
 * Every exam of a batch, each page with its registration, reading the template first if it has not
 * been. Throws ScanAlignmentRejectedError naming each page that should have lined up and did not.
 * The pages' OCR words are loaded here and dropped on return, so match does not hold a large
 * batch's words through the identity reads that follow.
 */
export async function alignBatch<P extends BatchPage>(
  admin: Admin,
  scope: ScanScope,
  exams: P[][]
): Promise<(P & { reg: Registration })[][]> {
  await ocrMissingTemplatePages(admin, scope);
  const [templates, ocr] = await Promise.all([
    loadTemplatePages(admin, scope.examId),
    loadBatchOcr(admin, scope.batchId)
  ]);
  const aligned: (P & { reg: Registration })[][] = [];
  const misaligned: number[] = [];
  for (const examPages of exams) {
    const exam: (P & { reg: Registration })[] = [];
    examPages.forEach((p, i) => {
      const reg = pageRegistration({ ...p, ocr_data: ocr.get(p.id) ?? null }, templates.get(i + 1));
      if (reg) exam.push({ ...p, reg });
      else misaligned.push(p.page_index + 1);
    });
    aligned.push(exam);
  }
  if (misaligned.length > 0) {
    const shown =
      misaligned.slice(0, 20).join(", ") + (misaligned.length > 20 ? `, and ${misaligned.length - 20} more` : "");
    throw new ScanAlignmentRejectedError(
      `batch ${scope.batchId}: page${misaligned.length === 1 ? "" : "s"} ${shown} could not be lined up with the template. ` +
        `Check the pages are in order and belong to this exam, rescan them, and run Process again.`
    );
  }
  return aligned;
}

async function loadBatchOcr(admin: Admin, batchId: number): Promise<Map<number, Json | null>> {
  const { data, error } = await admin.from("exam_scan_pages").select("id, ocr_data").eq("batch_id", batchId);
  if (error) throw new Error(`load OCR for batch ${batchId} failed: ${error.message}`);
  return new Map((data ?? []).map((p) => [p.id, p.ocr_data]));
}
