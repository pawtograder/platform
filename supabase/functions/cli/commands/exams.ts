/**
 * exams.* CLI commands: the Scans page workflow (lib/exam/examClient.ts) for scripts.
 *
 * Reads run on the service-role client, so every handler starts from openClass, which checks
 * the caller's class role, and loads a batch only through loadBatchContext, which binds it to
 * that class. Writes go through a client acting as the caller (userClient), so RLS, the
 * exam-scans storage policies, the user-role scan guards and the RPCs' own staff checks all
 * apply, as they do on the Scans page.
 */

import { createAuthenticatedSupabaseClient, type MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { classSummary, resolveAssignment, resolveClass } from "../utils/resolvers.ts";
import { assertUserCanAccessClass } from "../utils/auth.ts";
import { pageAll } from "../utils/paging.ts";
import { fetchProfileNames } from "../utils/profiles.ts";
import { courseFeatureEffectiveEnabled, EXAMS_FEATURE } from "../../_shared/courseFeatures.ts";
import {
  addPageError,
  pageIndexError,
  pagesPerExamError,
  parsePngDimensions,
  planFinalize,
  processBatchError,
  questionCheckRows,
  summarizeBatch,
  unevenPagesError
} from "../utils/examScans.ts";
import { decodeBase64Strict } from "../utils/base64.ts";
import { CLICommandError } from "../errors.ts";
import type { CLIResponse } from "../types.ts";

interface ClassParams {
  class?: string | number;
}

interface ExamParams extends ClassParams {
  assignment?: string | number;
}

interface BatchParams extends ClassParams {
  batch?: number | string;
}

interface CreateBatchParams extends ExamParams {
  pages_per_exam?: number;
  total_pages?: number;
}

interface FinalizeParams extends BatchParams {
  dry_run?: boolean;
}

interface UploadPageParams extends BatchParams {
  page_index?: number;
  content_base64?: string;
}

/**
 * A client acting as the caller, for writes. Minted right before the writes: its JWT lives
 * 60 seconds without refresh, so one minted before the reads could expire.
 */
function userClient(ctx: MCPAuthContext) {
  return createAuthenticatedSupabaseClient(ctx.userId);
}

function parseBatchId(raw: unknown): number {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CLICommandError("batch must be a positive integer batch id");
  }
  return value;
}

/**
 * The class, once the caller's role in it is checked. Write commands also need the exams
 * feature on, as the web hides the Scans page when it's off.
 */
async function openClass(ctx: MCPAuthContext, classIdentifier: string | number, write: boolean) {
  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);
  if (write && !courseFeatureEffectiveEnabled(classData.features, EXAMS_FEATURE, false)) {
    throw new CLICommandError("Paper exams are not enabled for this course", 403);
  }
  return { supabase, classData };
}

/** The assignment's exam template, in a class opened by openClass. */
async function loadExamContext(ctx: MCPAuthContext, p: ExamParams, write: boolean) {
  if (!p.class) throw new CLICommandError("class is required");
  if (!p.assignment) throw new CLICommandError("assignment is required");
  const { supabase, classData } = await openClass(ctx, p.class, write);
  const assignment = await resolveAssignment(supabase, classData.id, p.assignment);

  const { data: exam, error } = await supabase
    .from("exams")
    .select("id, num_pages")
    .eq("assignment_id", assignment.id)
    .eq("class_id", classData.id)
    .maybeSingle();
  if (error) throw new CLICommandError(`Failed to load exam: ${error.message}`, 500);
  if (!exam) throw new CLICommandError(`Assignment ${assignment.id} has no exam template`, 404);
  return { supabase, classData, assignment, exam };
}

/** The batch, if it belongs to the class opened by openClass. A batch in another class is reported as not found. */
async function loadBatchContext(ctx: MCPAuthContext, p: BatchParams, write: boolean) {
  if (!p.class) throw new CLICommandError("class is required");
  const batchId = parseBatchId(p.batch);
  const { supabase, classData } = await openClass(ctx, p.class, write);

  const { data: batch, error } = await supabase
    .from("exam_scan_batches")
    .select("id, exam_id, status, error, total_pages, pages_per_exam, created_at")
    .eq("id", batchId)
    .eq("class_id", classData.id)
    .maybeSingle();
  if (error) throw new CLICommandError(`Failed to load batch: ${error.message}`, 500);
  if (!batch) throw new CLICommandError(`Batch ${batchId} not found in this class`, 404);
  return { supabase, classData, batch };
}

async function handleExamsList(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as ClassParams;
  if (!p.class) throw new CLICommandError("class is required");
  const { supabase, classData } = await openClass(ctx, p.class, false);

  const [{ data: exams, error }, batches] = await Promise.all([
    supabase
      .from("exams")
      .select("id, assignment_id, num_pages, status, delivery_mode")
      .eq("class_id", classData.id)
      .order("id", { ascending: true }),
    pageAll<{ exam_id: number }>(
      () => supabase.from("exam_scan_batches").select("exam_id").eq("class_id", classData.id).order("id"),
      "Failed to load batches"
    )
  ]);
  if (error) throw new CLICommandError(`Failed to list exams: ${error.message}`, 500);

  const assignmentIds = (exams ?? []).map((e) => e.assignment_id);
  const { data: assignments, error: assignmentsError } = assignmentIds.length
    ? await supabase.from("assignments").select("id, slug, title").in("id", assignmentIds)
    : { data: [], error: null };
  if (assignmentsError) throw new CLICommandError(`Failed to load assignments: ${assignmentsError.message}`, 500);
  const assignmentById = new Map((assignments ?? []).map((a) => [a.id, a]));

  const batchCount = new Map<number, number>();
  for (const b of batches) batchCount.set(b.exam_id, (batchCount.get(b.exam_id) ?? 0) + 1);

  return {
    success: true,
    data: {
      class: classSummary(classData),
      exams: (exams ?? []).map((e) => ({
        id: e.id,
        assignment_id: e.assignment_id,
        assignment_slug: assignmentById.get(e.assignment_id)?.slug ?? null,
        assignment_title: assignmentById.get(e.assignment_id)?.title ?? null,
        num_pages: e.num_pages,
        status: e.status,
        delivery_mode: e.delivery_mode,
        batches: batchCount.get(e.id) ?? 0
      }))
    }
  };
}

async function handleExamsQuestions(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { supabase, classData, assignment, exam } = await loadExamContext(ctx, params as ExamParams, false);

  const { data: questions, error } = await supabase
    .from("exam_questions")
    .select("id, parent_id, level, ordinal, label, points, answer_type")
    .eq("exam_id", exam.id);
  if (error) throw new CLICommandError(`Failed to load questions: ${error.message}`, 500);

  const questionIds = (questions ?? []).map((q) => q.id);
  const { data: checks, error: checksError } = questionIds.length
    ? await supabase
        .from("rubric_checks")
        .select("id, name, points, rubric_id, exam_question_id")
        .eq("class_id", classData.id)
        .in("exam_question_id", questionIds)
    : { data: [], error: null };
  if (checksError) throw new CLICommandError(`Failed to load rubric checks: ${checksError.message}`, 500);

  return {
    success: true,
    data: {
      class: classSummary(classData),
      assignment: { id: assignment.id, slug: assignment.slug, title: assignment.title },
      exam: { id: exam.id, num_pages: exam.num_pages },
      grading_rubric_id: assignment.grading_rubric_id,
      questions: questionCheckRows(questions ?? [], checks ?? [], assignment.grading_rubric_id)
    }
  };
}

async function handleScansStatus(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { supabase, classData, batch } = await loadBatchContext(ctx, params as BatchParams, false);

  const [{ count, error: countError }, scanned] = await Promise.all([
    supabase.from("exam_scan_pages").select("id", { count: "exact", head: true }).eq("batch_id", batch.id),
    pageAll<{ match_status: string; finalized_at: string | null }>(
      () =>
        supabase
          .from("exam_scanned_submissions")
          .select("match_status, finalized_at")
          .eq("batch_id", batch.id)
          .order("id"),
      "Failed to load scanned exams"
    )
  ]);
  if (countError) throw new CLICommandError(`Failed to count pages: ${countError.message}`, 500);

  return {
    success: true,
    data: {
      class: classSummary(classData),
      batch: { id: batch.id, exam_id: batch.exam_id, created_at: batch.created_at },
      summary: summarizeBatch(batch, count ?? 0, scanned)
    }
  };
}

async function handleCreateBatch(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as CreateBatchParams;
  const totalPages = p.total_pages;
  if (typeof totalPages !== "number" || !Number.isInteger(totalPages) || totalPages < 1) {
    throw new CLICommandError("total_pages must be a positive integer");
  }
  const { classData, exam } = await loadExamContext(ctx, p, true);

  const mismatch = pagesPerExamError(exam.num_pages, p.pages_per_exam);
  if (mismatch) throw new CLICommandError(mismatch);
  const pagesPerExam = p.pages_per_exam as number;
  const uneven = unevenPagesError(totalPages, pagesPerExam);
  if (uneven) throw new CLICommandError(uneven);

  const writer = await userClient(ctx);
  const { data: batch, error } = await writer
    .from("exam_scan_batches")
    .insert({
      class_id: classData.id,
      exam_id: exam.id,
      total_pages: totalPages,
      pages_per_exam: pagesPerExam,
      status: "uploaded"
    })
    .select("id")
    .single();
  if (error || !batch) throw new CLICommandError(`Failed to create batch: ${error?.message}`, 500);

  return {
    success: true,
    data: {
      batch_id: batch.id,
      exam_id: exam.id,
      total_pages: totalPages,
      pages_per_exam: pagesPerExam
    }
  };
}

async function handleUploadPage(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as UploadPageParams;
  const { supabase, classData, batch } = await loadBatchContext(ctx, p, true);

  const indexError = pageIndexError(p.page_index, batch.total_pages);
  if (indexError) throw new CLICommandError(indexError);
  const pageIndex = p.page_index as number;
  const alreadyUploaded = {
    success: true,
    data: { batch_id: batch.id, page_index: pageIndex, already_uploaded: true }
  };

  const { data: existing, error: existingError } = await supabase
    .from("exam_scan_pages")
    .select("id")
    .eq("batch_id", batch.id)
    .eq("page_index", pageIndex)
    .maybeSingle();
  if (existingError) throw new CLICommandError(`Failed to check page: ${existingError.message}`, 500);
  if (existing) return alreadyUploaded;

  const statusError = addPageError(batch.status);
  if (statusError) throw new CLICommandError(statusError);

  const writer = await userClient(ctx);
  // As in uploadExamScanBatch: a failure part-way leaves the batch with only some of its pages,
  // so record why on the batch. enqueue_exam_process_batch also refuses a short batch.
  const fail = async (message: string, status: number): Promise<never> => {
    await writer
      .from("exam_scan_batches")
      .update({ status: "error", error: `incomplete upload: ${message}` })
      .eq("id", batch.id);
    throw new CLICommandError(message, status);
  };

  const bytes = decodeBase64Strict(p.content_base64 ?? "");
  const dimensions = bytes ? parsePngDimensions(bytes) : null;
  if (!bytes || !dimensions) return await fail(`scan page ${pageIndex} is not a base64-encoded PNG`, 400);

  const path = `classes/${classData.id}/exams/${batch.exam_id}/batches/${batch.id}/page-${pageIndex}.png`;
  const { error: uploadError } = await writer.storage
    .from("exam-scans")
    .upload(path, bytes, { contentType: "image/png", upsert: true });
  if (uploadError) return await fail(`upload scan page ${pageIndex} failed: ${uploadError.message}`, 500);

  const { error: insertError } = await writer.from("exam_scan_pages").insert({
    class_id: classData.id,
    exam_id: batch.exam_id,
    batch_id: batch.id,
    page_index: pageIndex,
    image_path: path,
    width: dimensions.width,
    height: dimensions.height
  });
  if (insertError?.code === "23505") return alreadyUploaded;
  if (insertError) return await fail(`insert scan page ${pageIndex} failed: ${insertError.message}`, 500);

  return {
    success: true,
    data: { batch_id: batch.id, page_index: pageIndex, width: dimensions.width, height: dimensions.height }
  };
}

async function handleScansProcess(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { batch } = await loadBatchContext(ctx, params as BatchParams, true);
  const notProcessable = processBatchError(batch.status);
  if (notProcessable) throw new CLICommandError(notProcessable);

  const writer = await userClient(ctx);
  const { data: pagesEnqueued, error } = await writer.rpc("enqueue_exam_process_batch", { p_batch_id: batch.id });
  if (error) throw new CLICommandError(error.message);

  return { success: true, data: { batch_id: batch.id, pages_enqueued: pagesEnqueued } };
}

async function handleScansFinalize(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as FinalizeParams;
  const { supabase, classData, batch } = await loadBatchContext(ctx, p, true);

  if (p.dry_run !== true) {
    const writer = await userClient(ctx);
    const { data: enqueued, error } = await writer.rpc("enqueue_exam_finalize", { p_batch_id: batch.id });
    if (error) throw new CLICommandError(error.message);
    return { success: true, data: { batch_id: batch.id, dry_run: false, enqueued } };
  }

  const [scanned, pages] = await Promise.all([
    pageAll<{
      id: number;
      exam_index: number;
      match_status: string;
      matched_profile_id: string | null;
      finalized_at: string | null;
    }>(
      () =>
        supabase
          .from("exam_scanned_submissions")
          .select("id, exam_index, match_status, matched_profile_id, finalized_at")
          .eq("batch_id", batch.id)
          .order("id"),
      "Failed to load scanned exams"
    ),
    pageAll<{ page_index: number; scanned_submission_id: number | null }>(
      () =>
        supabase
          .from("exam_scan_pages")
          .select("page_index, scanned_submission_id")
          .eq("batch_id", batch.id)
          .order("id"),
      "Failed to load scan pages"
    )
  ]);
  const studentNames = await fetchProfileNames(
    supabase,
    scanned.map((s) => s.matched_profile_id),
    classData.id
  );

  return {
    success: true,
    data: {
      batch_id: batch.id,
      dry_run: true,
      plan: planFinalize(scanned, pages, studentNames)
    }
  };
}

registerCommand({
  name: "exams.list",
  requiredScope: "cli:read",
  handler: handleExamsList
});

registerCommand({
  name: "exams.questions",
  requiredScope: "cli:read",
  handler: handleExamsQuestions
});

registerCommand({
  name: "exams.scans.status",
  requiredScope: "cli:read",
  handler: handleScansStatus
});

registerCommand({
  name: "exams.scans.create_batch",
  requiredScope: "cli:write",
  handler: handleCreateBatch
});

registerCommand({
  name: "exams.scans.upload_page",
  requiredScope: "cli:write",
  handler: handleUploadPage
});

registerCommand({
  name: "exams.scans.process",
  requiredScope: "cli:write",
  handler: handleScansProcess
});

registerCommand({
  name: "exams.scans.finalize",
  requiredScope: "cli:write",
  handler: handleScansFinalize
});
