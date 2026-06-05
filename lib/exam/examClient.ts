// Client-side orchestration for the instructor exam flow:
// rasterize PDFs in the browser, upload page PNGs to storage, and create the
// exam / scan-batch rows via RPCs. Pure data plumbing — UI lives in components.

import { Database } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";
import { rasterizePdf } from "./pdfRasterize";

export type UploadedTemplate = {
  examId: number;
  pages: { page_number: number; width: number; height: number }[];
};

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
  return { examId, pages };
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
  return { batchId, totalPages: rasters.length };
}
