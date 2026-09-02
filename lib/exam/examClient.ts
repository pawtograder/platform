// Client-side orchestration for the instructor exam flow:
// rasterize PDFs in the browser, upload page PNGs to storage, and create the
// exam / scan-batch rows via RPCs. Pure data plumbing — UI lives in components.

import { Database, Json } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";
import { generateExamPdf, type GeneratedQuestion } from "./pdfGenerate";
import { rasterizePdf, type RasterPage } from "./pdfRasterize";

export type UploadedTemplate = {
  examId: number;
  pages: { page_number: number; width: number; height: number }[];
};

/** A builder question: the layout fields generateExamPdf needs, plus the answer key. */
export type AssessmentQuestion = GeneratedQuestion & {
  /** Persisted exam_questions.id (null = new); echoed back so the upsert keeps ids stable. */
  id?: number | null;
  points?: number | null;
  correct_answer?: unknown;
  grading_tolerance?: number | null;
};

/**
 * Upload rasterized template pages to the exam-templates bucket and (re)create the
 * exam_template_pages rows. Shared by the upload-a-PDF and generate-a-PDF flows.
 */
async function uploadTemplatePages(
  supabase: SupabaseClient<Database>,
  classId: number,
  examId: number,
  rasters: RasterPage[]
): Promise<UploadedTemplate["pages"]> {
  // remove any previous template pages for a clean re-upload
  const { error: delErr } = await supabase.from("exam_template_pages").delete().eq("exam_id", examId);
  if (delErr) throw new Error(`clear previous template pages failed: ${delErr.message}`);

  const pages: UploadedTemplate["pages"] = [];
  for (const r of rasters) {
    const path = `classes/${classId}/exams/${examId}/template/page-${r.pageNumber}.png`;
    const up = await supabase.storage.from("exam-templates").upload(path, r.blob, {
      contentType: "image/png",
      upsert: true
    });
    if (up.error) throw new Error(`upload template page ${r.pageNumber} failed: ${up.error.message}`);
    const { error: insErr } = await supabase.from("exam_template_pages").insert({
      class_id: classId,
      exam_id: examId,
      page_number: r.pageNumber,
      image_path: path,
      width: r.width,
      height: r.height
    });
    if (insErr) throw new Error(`insert template page failed: ${insErr.message}`);
    pages.push({ page_number: r.pageNumber, width: r.width, height: r.height });
  }
  return pages;
}

/** Rasterize a template PDF, upload page PNGs, and (re)create the exam + template pages. */
export async function uploadExamTemplate(
  supabase: SupabaseClient<Database>,
  classId: number,
  assignmentId: number,
  file: File
): Promise<UploadedTemplate> {
  const rasters = await rasterizePdf(file, 2);

  const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
    p_assignment_id: assignmentId,
    p_source_type: "pdf",
    p_num_pages: rasters.length
  });
  if (examErr || !examId) throw new Error(`exam_create failed: ${examErr?.message}`);

  const pages = await uploadTemplatePages(supabase, classId, examId, rasters);
  return { examId, pages };
}

/**
 * Generate a printable PDF from a question tree (so every answer region is known
 * exactly), upload it + its rasterized pages, and persist the questions + regions.
 * Used by the quiz/exam builder's "Generate printable PDF" path — no upload, no vision.
 */
export async function generateAndUploadExamTemplate(
  supabase: SupabaseClient<Database>,
  classId: number,
  assignmentId: number,
  questions: AssessmentQuestion[],
  opts: { deliveryMode?: "paper" | "in_app"; title?: string } = {}
): Promise<UploadedTemplate & { regions: number }> {
  const { bytes, regions } = await generateExamPdf(questions, { title: opts.title });
  const rasters = await rasterizePdf(bytes, 2);

  const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
    p_assignment_id: assignmentId,
    p_source_type: "generated",
    p_num_pages: rasters.length,
    // Left undefined (and so omitted from the request body) when the caller did not choose a
    // mode, which makes exam_create fall back to its NULL default = "keep the existing mode".
    // Defaulting to "paper" here used to flip an in_app quiz to paper on any re-save.
    p_delivery_mode: opts.deliveryMode
  });
  if (examErr || !examId) throw new Error(`exam_create failed: ${examErr?.message}`);

  // keep the source PDF around for re-download / printing
  const pdfPath = `classes/${classId}/exams/${examId}/template/generated.pdf`;
  const pdfUp = await supabase.storage
    .from("exam-templates")
    .upload(pdfPath, new Blob([bytes as BlobPart], { type: "application/pdf" }), {
      contentType: "application/pdf",
      upsert: true
    });
  if (pdfUp.error) throw new Error(`upload generated pdf failed: ${pdfUp.error.message}`);
  // This is the only write of template_pdf_path. Swallowing the error let the caller resolve
  // successfully and the builder show "Download printable PDF" from local state, while after a
  // reload the path was missing and the generated PDF looked lost.
  const { error: pdfPathErr } = await supabase.from("exams").update({ template_pdf_path: pdfPath }).eq("id", examId);
  if (pdfPathErr) throw new Error(`record generated pdf path failed: ${pdfPathErr.message}`);

  const pages = await uploadTemplatePages(supabase, classId, examId, rasters);

  const { error: upsertErr } = await supabase.rpc("exam_upsert_questions_and_regions", {
    p_exam_id: examId,
    p_questions: questions.map((q) => ({
      id: q.id ?? null,
      client_id: q.client_id,
      parent_client_id: q.parent_client_id,
      level: q.level,
      ordinal: q.ordinal,
      label: q.label ?? null,
      prompt: q.prompt ?? null,
      answer_type: q.answer_type ?? null,
      choices: q.choices ?? null,
      points: q.points ?? null,
      correct_answer: (q.correct_answer ?? null) as Json,
      grading_tolerance: q.grading_tolerance ?? null
    })) as unknown as Json,
    p_regions: regions.map((r) => ({
      question_client_id: r.question_client_id,
      kind: r.kind,
      page_number: r.page_number,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height
    }))
  });
  if (upsertErr) throw new Error(`persist questions/regions failed: ${upsertErr.message}`);

  return { examId, pages, regions: regions.length };
}

/** Rasterize a scanned-exam PDF, upload page PNGs, and create the scan batch + pages. */
export async function uploadExamScanBatch(
  supabase: SupabaseClient<Database>,
  classId: number,
  examId: number,
  file: File,
  pagesPerExam: number
): Promise<{ batchId: number; totalPages: number }> {
  const rasters = await rasterizePdf(file, 2);

  // Validate pages-per-exam against the template before creating anything. Staff type this by
  // hand, and a value below the template's page count still divides an even scan cleanly -- so
  // pages from different students end up in one exam and the regions on the template pages
  // beyond the chosen count are skipped at finalization. enqueue_exam_process_batch enforces
  // the same rule (it is the one that matters); checking here means the instructor is told
  // before uploading every page.
  const { data: exam, error: examErr } = await supabase.from("exams").select("num_pages").eq("id", examId).single();
  if (examErr || !exam) throw new Error(`load exam ${examId} failed: ${examErr?.message}`);
  const templatePages = exam.num_pages ?? 0;
  if (templatePages > 0 && pagesPerExam !== templatePages) {
    throw new Error(
      `This exam's template has ${templatePages} page(s), but the scan is set to ${pagesPerExam} ` +
        `page(s) per exam. Set pages-per-exam to ${templatePages} before uploading.`
    );
  }

  const { data: batch, error: batchErr } = await supabase
    .from("exam_scan_batches")
    .insert({
      class_id: classId,
      exam_id: examId,
      total_pages: rasters.length,
      // pages_per_exam is an integer column; guard against decimals / NaN from the caller.
      pages_per_exam: Math.max(1, Math.floor(Number.isFinite(pagesPerExam) ? pagesPerExam : 1)),
      status: "uploaded"
    })
    .select("id")
    .single();
  if (batchErr || !batch) throw new Error(`create batch failed: ${batchErr?.message}`);
  const batchId = batch.id;

  // The batch row already claims the full total_pages, so a failure part-way through leaves a
  // batch holding only a prefix of its pages. Record that on the batch so staff can see why it
  // stalled; enqueue_exam_process_batch independently refuses to process any batch whose
  // persisted page count differs from total_pages, so a partial batch can't be OCR'd/matched.
  try {
    for (let i = 0; i < rasters.length; i++) {
      const r = rasters[i];
      const path = `classes/${classId}/exams/${examId}/batches/${batchId}/page-${i}.png`;
      const up = await supabase.storage.from("exam-scans").upload(path, r.blob, {
        contentType: "image/png",
        upsert: true
      });
      if (up.error) throw new Error(`upload scan page ${i} failed: ${up.error.message}`);
      const { error: insErr } = await supabase.from("exam_scan_pages").insert({
        class_id: classId,
        exam_id: examId,
        batch_id: batchId,
        page_index: i,
        image_path: path,
        width: r.width,
        height: r.height
      });
      if (insErr) throw new Error(`insert scan page failed: ${insErr.message}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabase
      .from("exam_scan_batches")
      .update({ status: "error", error: `incomplete upload: ${message}` })
      .eq("id", batchId);
    throw e;
  }
  return { batchId, totalPages: rasters.length };
}
