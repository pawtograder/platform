/**
 * CLI submissions — batch comment import/sync (Postgres RPC) and artifact blob import.
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import type { Json } from "../../_shared/SupabaseTypes.d.ts";
import { registerCommand } from "../router.ts";
import { CLICommandError } from "../errors.ts";
import type { CLIResponse } from "../types.ts";
import type {
  ImportCommentsPayload,
  SubmissionsArtifactsImportParams,
  SubmissionsCommentsImportParams
} from "../types.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveAssignment, resolveClass } from "../utils/resolvers.ts";

const COMMENT_CHUNK = 120;

async function assertUserCanAccessClass(userId: string, classId: number): Promise<void> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("user_roles")
    .select("id")
    .eq("user_id", userId)
    .eq("class_id", classId)
    .eq("disabled", false)
    .in("role", ["instructor", "grader"])
    .limit(1)
    .maybeSingle();

  if (error) throw new CLICommandError(`Failed to verify class access: ${error.message}`, 500);
  if (!data) {
    throw new CLICommandError("You do not have instructor/grader access to this class", 403);
  }
}

async function fetchAssigneesForRubricPart(
  submissionIds: number[],
  rubricPartId: number
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (submissionIds.length === 0) return out;

  const supabase = getAdminClient();
  const BATCH = 100;
  const PAGE = 1000;
  const reviewAssignmentIds = new Set<number>();
  const submissionToAssignments = new Map<number, Array<{ id: number; assignee_profile_id: string }>>();

  for (let i = 0; i < submissionIds.length; i += BATCH) {
    const batch = submissionIds.slice(i, i + BATCH);
    let page = 0;
    let more = true;
    while (more) {
      const { data: rows, error } = await supabase
        .from("review_assignments")
        .select("id, submission_id, assignee_profile_id")
        .in("submission_id", batch)
        .range(page * PAGE, (page + 1) * PAGE - 1);
      if (error) throw new CLICommandError(`review_assignments: ${error.message}`, 500);
      if (!rows?.length) {
        more = false;
        break;
      }
      for (const r of rows) {
        reviewAssignmentIds.add(r.id);
        const list = submissionToAssignments.get(r.submission_id) ?? [];
        list.push({ id: r.id, assignee_profile_id: r.assignee_profile_id });
        submissionToAssignments.set(r.submission_id, list);
      }
      if (rows.length < PAGE) more = false;
      else page++;
    }
  }

  if (reviewAssignmentIds.size === 0) return out;

  const raToParts = new Map<number, Set<number>>();
  const raList = Array.from(reviewAssignmentIds);
  for (let i = 0; i < raList.length; i += BATCH) {
    const batch = raList.slice(i, i + BATCH);
    let page = 0;
    let more = true;
    while (more) {
      const { data: rows, error } = await supabase
        .from("review_assignment_rubric_parts")
        .select("review_assignment_id, rubric_part_id")
        .in("review_assignment_id", batch)
        .range(page * PAGE, (page + 1) * PAGE - 1);
      if (error) throw new CLICommandError(`review_assignment_rubric_parts: ${error.message}`, 500);
      if (!rows?.length) {
        more = false;
        break;
      }
      for (const r of rows) {
        const s = raToParts.get(r.review_assignment_id) ?? new Set<number>();
        s.add(r.rubric_part_id);
        raToParts.set(r.review_assignment_id, s);
      }
      if (rows.length < PAGE) more = false;
      else page++;
    }
  }

  for (const [submissionId, assignments] of submissionToAssignments) {
    for (const assignment of assignments) {
      const parts = raToParts.get(assignment.id);
      if (!parts || parts.size === 0 || parts.has(rubricPartId)) {
        out.set(submissionId, assignment.assignee_profile_id);
        break;
      }
    }
  }

  return out;
}

type WorkItem =
  | { kind: "file"; row: ImportCommentsPayload["file_comments"][number] }
  | { kind: "artifact"; row: ImportCommentsPayload["artifact_comments"][number] }
  | { kind: "submission"; row: ImportCommentsPayload["submission_comments"][number] };

function buildWorkQueue(payload: ImportCommentsPayload): WorkItem[] {
  const q: WorkItem[] = [];
  for (const row of payload.file_comments) q.push({ kind: "file", row });
  for (const row of payload.artifact_comments) q.push({ kind: "artifact", row });
  for (const row of payload.submission_comments) q.push({ kind: "submission", row });
  return q;
}

function slicePayloadFromWork(work: WorkItem[]): {
  file_comments: ImportCommentsPayload["file_comments"];
  artifact_comments: ImportCommentsPayload["artifact_comments"];
  submission_comments: ImportCommentsPayload["submission_comments"];
} {
  const file_comments: ImportCommentsPayload["file_comments"] = [];
  const artifact_comments: ImportCommentsPayload["artifact_comments"] = [];
  const submission_comments: ImportCommentsPayload["submission_comments"] = [];
  for (const w of work) {
    if (w.kind === "file") file_comments.push(w.row);
    else if (w.kind === "artifact") artifact_comments.push(w.row);
    else submission_comments.push(w.row);
  }
  return { file_comments, artifact_comments, submission_comments };
}

function emptySummary() {
  return {
    file_comments: { inserted: 0, skipped: 0, errors: 0 },
    artifact_comments: { inserted: 0, skipped: 0, errors: 0 },
    submission_comments: { inserted: 0, skipped: 0, errors: 0 },
    sync_deleted: { file_comments: 0, artifact_comments: 0, submission_comments: 0 }
  };
}

function mergeRpcSummary(
  acc: ReturnType<typeof emptySummary>,
  data: {
    summary?: Record<string, Record<string, number>>;
  }
) {
  const s = data.summary;
  if (!s) return;
  for (const key of ["file_comments", "artifact_comments", "submission_comments"] as const) {
    const part = s[key];
    if (!part) continue;
    acc[key].inserted += Number(part.inserted ?? 0);
    acc[key].skipped += Number(part.skipped ?? 0);
    acc[key].errors += Number(part.errors ?? 0);
  }
  const sd = s.sync_deleted;
  if (sd) {
    acc.sync_deleted.file_comments += Number(sd.file_comments ?? 0);
    acc.sync_deleted.artifact_comments += Number(sd.artifact_comments ?? 0);
    acc.sync_deleted.submission_comments += Number(sd.submission_comments ?? 0);
  }
}

async function runCommentsImportOrSync(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as SubmissionsCommentsImportParams;
  if (!p.class) throw new CLICommandError("class is required");
  if (!p.assignment) throw new CLICommandError("assignment is required");
  if (!p.payload) throw new CLICommandError("payload is required");
  if (p.mode !== "import" && p.mode !== "sync") {
    throw new CLICommandError("mode must be import or sync");
  }

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  const assignment = await resolveAssignment(supabase, classData.id, p.assignment);

  await assertUserCanAccessClass(ctx.userId, classData.id);

  const dryRun = p.dry_run === true;
  const payload = p.payload;
  const syncIds = payload.sync_submission_ids ?? [];

  const queue = buildWorkQueue(payload);

  const rpcArgsBase = {
    p_class_id: classData.id,
    p_assignment_id: assignment.id,
    p_dry_run: dryRun,
    p_sync_submission_ids: syncIds.length > 0 ? syncIds : ([] as number[]),
    p_authors_by_submission: {} as unknown as Json
  };

  const summary = emptySummary();
  const errorsDetail: Json[] = [];

  for (let i = 0; i < queue.length; i += COMMENT_CHUNK) {
    const slice = queue.slice(i, i + COMMENT_CHUNK);
    const { file_comments, artifact_comments, submission_comments } = slicePayloadFromWork(slice);
    const { data, error } = await supabase.rpc("cli_import_submission_comments_batch", {
      ...rpcArgsBase,
      p_mode: "import",
      p_file_comments: file_comments as unknown as Json,
      p_artifact_comments: artifact_comments as unknown as Json,
      p_submission_comments: submission_comments as unknown as Json,
      p_default_author: null,
      p_skip_sync: true,
      p_run_sync_only: false
    });

    if (error) throw new CLICommandError(`RPC error: ${error.message}`, 500);
    const row = data as { summary?: Record<string, Record<string, number>>; errors_detail?: Json[] };
    mergeRpcSummary(summary, row);
    if (Array.isArray(row.errors_detail)) {
      errorsDetail.push(...row.errors_detail);
    }
  }

  if (p.mode === "sync") {
    const { data, error } = await supabase.rpc("cli_import_submission_comments_batch", {
      ...rpcArgsBase,
      p_mode: "sync",
      p_file_comments: payload.file_comments as unknown as Json,
      p_artifact_comments: payload.artifact_comments as unknown as Json,
      p_submission_comments: payload.submission_comments as unknown as Json,
      p_default_author: null,
      p_skip_sync: false,
      p_run_sync_only: true
    });
    if (error) throw new CLICommandError(`RPC sync error: ${error.message}`, 500);
    const row = data as { summary?: Record<string, Record<string, number>>; errors_detail?: Json[] };
    mergeRpcSummary(summary, row);
    if (Array.isArray(row.errors_detail)) {
      errorsDetail.push(...row.errors_detail);
    }
  }

  return {
    success: true,
    data: {
      mode: p.mode,
      dry_run: dryRun,
      class_id: classData.id,
      assignment_id: assignment.id,
      summary,
      errors: errorsDetail
    }
  };
}

async function handleCommentsImport(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  return handleCommentsPrepare(ctx, { ...params, mode: "import" });
}

async function handleCommentsSync(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  return handleCommentsPrepare(ctx, { ...params, mode: "sync" });
}

async function handleCommentsPrepare(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as {
    class: string;
    assignment: string;
    raw: {
      file_comments?: ImportCommentsPayload["file_comments"];
      artifact_comments?: ImportCommentsPayload["artifact_comments"];
      submission_comments?: ImportCommentsPayload["submission_comments"];
      sync_submission_ids?: number[];
      violations?: Array<{
        student_id: string;
        submission_id: number;
        rubric_check_id: number;
        file_name: string;
        line: number;
        comment: string;
      }>;
      partial_credits?: Array<{
        student_id: string;
        submission_id: number;
        rubric_check_id: number;
        file_name: string;
        line: number;
        comment: string;
      }>;
      summary?: { students?: Array<{ profile_id: string; submission_id: number }> };
    };
    author_profile_id?: string | null;
    rubric_part_id?: number | null;
    mode: "import" | "sync";
    dry_run?: boolean;
  };

  if (!p.class) throw new CLICommandError("class is required");
  if (!p.assignment) throw new CLICommandError("assignment is required");
  if (!p.raw) throw new CLICommandError("raw is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  const assignment = await resolveAssignment(supabase, classData.id, p.assignment);
  await assertUserCanAccessClass(ctx.userId, classData.id);

  if (p.author_profile_id && p.rubric_part_id) {
    throw new CLICommandError("Specify only one of author_profile_id or rubric_part_id");
  }
  if (!p.author_profile_id && !p.rubric_part_id) {
    throw new CLICommandError("author_profile_id or rubric_part_id is required");
  }

  const fileFromLegacy: ImportCommentsPayload["file_comments"] = [];
  const violations = [...(p.raw.violations ?? []), ...(p.raw.partial_credits ?? [])];
  for (const v of violations) {
    fileFromLegacy.push({
      submission_id: v.submission_id,
      file_name: v.file_name,
      line: v.line,
      comment: v.comment,
      rubric_check_id: v.rubric_check_id,
      author: "" as string
    });
  }

  let file_comments = [...(p.raw.file_comments ?? []), ...fileFromLegacy];
  const artifact_comments = [...(p.raw.artifact_comments ?? [])];
  const submission_comments = [...(p.raw.submission_comments ?? [])];

  const submissionIds = new Set<number>();
  for (const r of file_comments) submissionIds.add(r.submission_id);
  for (const r of artifact_comments) submissionIds.add(r.submission_id);
  for (const r of submission_comments) submissionIds.add(r.submission_id);

  if (p.author_profile_id) {
    const aid = p.author_profile_id;
    file_comments = file_comments.map((row) => ({ ...row, author: aid }));
    for (const row of artifact_comments) {
      row.author = aid;
    }
    for (const row of submission_comments) {
      row.author = aid;
    }
  } else if (p.rubric_part_id != null) {
    const assignees = await fetchAssigneesForRubricPart(Array.from(submissionIds), p.rubric_part_id);
    for (const row of file_comments) {
      const a = assignees.get(row.submission_id);
      if (!a) throw new CLICommandError(`No review assignee for submission ${row.submission_id}`, 400);
      row.author = a;
    }
    for (const row of artifact_comments) {
      const a = assignees.get(row.submission_id);
      if (!a) throw new CLICommandError(`No review assignee for submission ${row.submission_id}`, 400);
      row.author = a;
    }
    for (const row of submission_comments) {
      const a = assignees.get(row.submission_id);
      if (!a) throw new CLICommandError(`No review assignee for submission ${row.submission_id}`, 400);
      row.author = a;
    }
  }

  let sync_submission_ids = p.raw.sync_submission_ids;
  if (!sync_submission_ids?.length && p.raw.summary?.students?.length) {
    sync_submission_ids = p.raw.summary.students.map((s) => s.submission_id);
  } else if (!sync_submission_ids?.length && p.mode === "sync") {
    sync_submission_ids = Array.from(submissionIds);
  }

  const payload: ImportCommentsPayload = {
    file_comments,
    artifact_comments,
    submission_comments,
    sync_submission_ids: sync_submission_ids ?? []
  };

  return runCommentsImportOrSync(ctx, {
    class: p.class,
    assignment: p.assignment,
    payload,
    mode: p.mode,
    dry_run: p.dry_run
  });
}

async function handleArtifactsImport(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as SubmissionsArtifactsImportParams;
  if (!p.class) throw new CLICommandError("class is required");
  if (!p.assignment) throw new CLICommandError("assignment is required");
  if (!p.artifacts?.length) throw new CLICommandError("artifacts array is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  const assignment = await resolveAssignment(supabase, classData.id, p.assignment);
  await assertUserCanAccessClass(ctx.userId, classData.id);

  const dryRun = p.dry_run === true;
  const overwrite = p.overwrite === true;
  let uploaded = 0;
  let skipped = 0;
  let overwritten = 0;
  const errors: Array<{ submission_id: number; artifact_name: string; reason: string }> = [];

  for (const art of p.artifacts) {
    const { data: sub, error: subErr } = await supabase
      .from("submissions")
      .select("id, class_id, assignment_id, profile_id, assignment_group_id")
      .eq("id", art.submission_id)
      .maybeSingle();

    if (subErr || !sub) {
      errors.push({
        submission_id: art.submission_id,
        artifact_name: art.name,
        reason: subErr?.message ?? "submission_not_found"
      });
      continue;
    }
    if (sub.class_id !== classData.id || sub.assignment_id !== assignment.id) {
      errors.push({
        submission_id: art.submission_id,
        artifact_name: art.name,
        reason: "submission_not_in_class_assignment"
      });
      continue;
    }

    const profileSlot = sub.profile_id ?? sub.assignment_group_id;
    if (profileSlot == null) {
      errors.push({
        submission_id: art.submission_id,
        artifact_name: art.name,
        reason: "submission_missing_profile_and_group"
      });
      continue;
    }

    let bytes: Uint8Array;
    try {
      const bin = atob(art.content_base64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      errors.push({
        submission_id: art.submission_id,
        artifact_name: art.name,
        reason: "invalid_base64"
      });
      continue;
    }

    if (dryRun) {
      const { data: existing } = await supabase
        .from("submission_artifacts")
        .select("id")
        .eq("submission_id", art.submission_id)
        .eq("name", art.name)
        .maybeSingle();
      if (existing && !overwrite) skipped++;
      else if (existing && overwrite) overwritten++;
      else uploaded++;
      continue;
    }

    const { data: existing } = await supabase
      .from("submission_artifacts")
      .select("id")
      .eq("submission_id", art.submission_id)
      .eq("name", art.name)
      .maybeSingle();

    if (existing && !overwrite) {
      skipped++;
      continue;
    }

    if (existing && overwrite) {
      await supabase.from("submission_artifact_comments").delete().eq("submission_artifact_id", existing.id);
      const oldPath = `classes/${classData.id}/profiles/${profileSlot}/submissions/${art.submission_id}/${existing.id}`;
      await supabase.storage.from("submission-artifacts").remove([oldPath]);
      await supabase.from("submission_artifacts").delete().eq("id", existing.id);
      overwritten++;
    }

    const { data: inserted, error: insErr } = await supabase
      .from("submission_artifacts")
      .insert({
        class_id: classData.id,
        submission_id: art.submission_id,
        name: art.name,
        data: art.data as unknown as Json,
        profile_id: sub.profile_id,
        assignment_group_id: sub.assignment_group_id
      })
      .select("id")
      .single();

    if (insErr || !inserted?.id) {
      errors.push({
        submission_id: art.submission_id,
        artifact_name: art.name,
        reason: insErr?.message ?? "insert_failed"
      });
      continue;
    }

    const path = `classes/${classData.id}/profiles/${profileSlot}/submissions/${art.submission_id}/${inserted.id}`;
    const { error: upErr } = await supabase.storage.from("submission-artifacts").upload(path, bytes, {
      upsert: true,
      contentType: "application/octet-stream"
    });
    if (upErr) {
      await supabase.from("submission_artifacts").delete().eq("id", inserted.id);
      errors.push({
        submission_id: art.submission_id,
        artifact_name: art.name,
        reason: upErr.message
      });
      continue;
    }
    uploaded++;
  }

  return {
    success: true,
    data: {
      dry_run: dryRun,
      summary: { uploaded, skipped, overwritten, errors: errors.length },
      errors
    }
  };
}

registerCommand({
  name: "submissions.comments.import",
  requiredScope: "cli:write",
  handler: handleCommentsImport
});

registerCommand({
  name: "submissions.comments.sync",
  requiredScope: "cli:write",
  handler: handleCommentsSync
});

registerCommand({
  name: "submissions.artifacts.import",
  requiredScope: "cli:write",
  handler: handleArtifactsImport
});
