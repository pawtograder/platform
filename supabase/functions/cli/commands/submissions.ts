/**
 * CLI submissions — batch comment import/sync (Postgres RPC) and artifact blob import.
 */

import { Buffer } from "node:buffer";
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
import { classSummary, resolveAssignment, resolveClass } from "../utils/resolvers.ts";
import { assertUserCanAccessClass } from "../utils/auth.ts";
import { pageAll } from "../utils/paging.ts";
import { gradingTotalForStudent } from "../utils/gradingTotals.ts";
import { resolveSelectors } from "../utils/selectors.ts";
import { createExportTokenizer } from "../utils/assessmentExportPepper.ts";
import { validateExportIdentityParams } from "../utils/exportIdentity.ts";
import { streamNdjson } from "../utils/ndjson.ts";
import { streamSubmissionFiles } from "../utils/submissionFilesExportStream.ts";
import { streamSubmissions } from "../utils/submissionExportStream.ts";
import type { IdentityMode } from "../utils/tokenization.ts";

const COMMENT_CHUNK = 120;
const SUBMISSIONS_EXPORT_SCHEMA_VERSION = 1;

const SUBMISSIONS_EXPORT_PRIVACY_NOTES = [
  "Tokens use HMAC with a server-side pepper; opaque-mode salt is ephemeral per run.",
  "File contents are not redacted — student names may appear in source code.",
  "Repository URLs are included as course metadata."
];

type SubmissionsExportSection = "catalog" | "meta" | "files";

const SUBMISSIONS_EXPORT_SECTIONS = new Set<SubmissionsExportSection>(["catalog", "meta", "files"]);

interface SubmissionsExportParams {
  class?: string | number;
  /** Single assignment for meta/files sections. */
  assignment?: string | number;
  /** Assignment selectors for catalog section (id, slug, or glob). Omit => all in class. */
  assignments?: Array<string | number>;
  identity_mode?: IdentityMode;
  salt?: string;
  confirm_pii?: boolean;
  dump_id?: string;
  all_submissions?: boolean;
  with_binary?: boolean;
  /** Glob patterns on submission_files.name — must match at least one if set. */
  include_files?: string[];
  /** Glob patterns on submission_files.name — skipped when any match. */
  exclude_files?: string[];
  section?: SubmissionsExportSection;
  files_batch_index?: number;
  /** Raw submission ids from a prior meta section — used only for section=files. */
  submission_ids?: number[];
}

/**
 * Every `submission_artifacts` row already stored under this (submission_id, name).
 *
 * A list read rather than `.maybeSingle()`, and the error is returned rather than
 * discarded. `submission_artifacts` has no unique index on (submission_id, name) — only
 * its primary key — and the overwrite path inserts before it deletes, so an interrupted
 * run leaves two rows. `.maybeSingle()` answers PGRST116 with `data: null` for exactly
 * that state, so swallowing the error made the handler conclude nothing was stored:
 * `--overwrite` became a permanent no-op that added one more row per invocation, and the
 * grading comments stayed attached to the artifact the operator meant to replace.
 */
async function findExistingArtifacts(
  supabase: ReturnType<typeof getAdminClient>,
  submissionId: number,
  name: string
): Promise<{ data: Array<{ id: number }>; error: string | null }> {
  const { data, error } = await supabase
    .from("submission_artifacts")
    .select("id")
    .eq("submission_id", submissionId)
    .eq("name", name)
    .order("id", { ascending: true });
  if (error) return { data: [], error: `failed to look up existing artifact: ${error.message}` };
  return { data: data ?? [], error: null };
}

/**
 * Rejects caller-supplied submission ids that are not part of the resolved assignment.
 *
 * Every handler runs on the service-role client, so an id from the request body is
 * otherwise used verbatim: `.in("submission_id", ids)` on a table that carries no
 * class predicate reaches the whole deployment, and submission ids are sequential, so
 * enumeration is trivial. `assertUserCanAccessClass` authorizes the *class*, not the
 * ids, so this is the step that ties the two together and it has to run on every path
 * that accepts ids — reads and writes alike.
 */
async function assertSubmissionsBelongToAssignment(
  supabase: ReturnType<typeof getAdminClient>,
  classId: number,
  assignmentId: number,
  requestedIds: number[],
  label: string
): Promise<number[]> {
  const unique = [...new Set(requestedIds)];
  if (unique.length === 0) return [];

  const ownedIds: number[] = [];
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const rows = await pageAll<{ id: number }>(
      () =>
        supabase
          .from("submissions")
          .select("id")
          .eq("class_id", classId)
          .eq("assignment_id", assignmentId)
          .in("id", batch)
          .order("id", { ascending: true }),
      `Failed to validate ${label}`
    );
    ownedIds.push(...rows.map((r) => r.id));
  }

  const ownedSet = new Set(ownedIds);
  const foreignIds = unique.filter((id) => !ownedSet.has(id));
  if (foreignIds.length > 0) {
    throw new CLICommandError(
      `${label}: these submission ids do not belong to assignment ${assignmentId} in class ${classId}: ` +
        foreignIds.slice(0, 20).join(", ") +
        (foreignIds.length > 20 ? ` (and ${foreignIds.length - 20} more)` : ""),
      400
    );
  }
  return ownedIds;
}

/**
 * `classId`/`assignmentId` scope the lookup. The submission ids come from the caller's
 * payload and are only validated row by row inside the RPC, so an unscoped
 * `.in("submission_id", ids)` on the service-role client answered for other classes:
 * the returned `skipped_without_review_assignee` set then discloses, by its complement,
 * which of another class's submissions are assigned for a rubric part.
 */
async function fetchAssigneesForRubricPart(
  classId: number,
  assignmentId: number,
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
        .eq("class_id", classId)
        .eq("assignment_id", assignmentId)
        .in("submission_id", batch)
        // Ordered: unordered .range() paging can skip or duplicate rows, and the
        // first match below becomes the recorded comment author — so without a
        // stable order the attribution varied between runs.
        .order("id", { ascending: true })
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
        .order("id", { ascending: true })
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

/**
 * Decodes base64, returning null when the input was not valid base64.
 *
 * `Buffer.from(x, "base64")` never throws — it drops characters outside the
 * alphabet — so the only way to know the input decoded losslessly is to re-encode
 * and compare. Without this a corrupt manifest uploaded truncated artifact bytes
 * and reported success.
 */
/** Base64 with at least one data character, optional trailing padding, nothing else. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64Strict(input: string): Uint8Array | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const normalized = input.replace(/\s+/g, "");

  // The grammar is checked before decoding. Padding-only input ("=", "====", or
  // whitespace around one) slipped through the re-encode comparison below, because
  // Buffer decodes it to zero bytes and stripping padding reduces both operands to the
  // empty string — so `--overwrite` replaced a real artifact with an empty object and
  // reported success. Requiring a data character also rules out the empty payload,
  // which the length guard above already rejected in its unpadded form.
  if (!BASE64_RE.test(normalized)) return null;
  // 4n+1 is not a reachable length for base64; the re-encode check catches it too, but
  // failing here says why.
  if (normalized.replace(/=+$/, "").length % 4 === 1) return null;

  const buf = Buffer.from(normalized, "base64");
  if (buf.length === 0) return null;
  // Re-encoding is canonical, so compare against the canonicalized input: strip
  // padding from both sides rather than requiring the caller to pad exactly.
  const reencoded = buf.toString("base64").replace(/=+$/, "");
  if (reencoded !== normalized.replace(/=+$/, "")) return null;
  return new Uint8Array(buf);
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

  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

  const dryRun = p.dry_run === true;
  const payload = p.payload;
  const syncIds = payload.sync_submission_ids ?? [];

  // `sync_submission_ids` is the sole predicate of the RPC's three soft-delete
  // UPDATEs (`submission_id = ANY (v_sync_ids)` — see
  // 20260319120000_cli_import_submission_comments_batch.sql), which carry no class or
  // assignment filter of their own. Passing the caller's ids through unchecked let a
  // grader in one class soft-delete another class's grading comments and still get
  // `success: true`; the insert path is protected only because the RPC rejects
  // out-of-class rows individually, which the deletes do not do.
  await assertSubmissionsBelongToAssignment(supabase, classData.id, assignment.id, syncIds, "sync_submission_ids");

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
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

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
  let artifact_comments = [...(p.raw.artifact_comments ?? [])];
  let submission_comments = [...(p.raw.submission_comments ?? [])];

  const submissionIds = new Set<number>();
  for (const r of file_comments) submissionIds.add(r.submission_id);
  for (const r of artifact_comments) submissionIds.add(r.submission_id);
  for (const r of submission_comments) submissionIds.add(r.submission_id);

  /** Submissions skipped: no review assignee for the chosen rubric part */
  const skippedNoReviewAssignee = new Set<number>();

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
    const ids = Array.from(submissionIds);
    const assignees = await fetchAssigneesForRubricPart(classData.id, assignment.id, ids, p.rubric_part_id);

    for (const sid of ids) {
      if (!assignees.has(sid)) skippedNoReviewAssignee.add(sid);
    }

    const keep = (sid: number) => !skippedNoReviewAssignee.has(sid);
    file_comments = file_comments
      .filter((row) => keep(row.submission_id))
      .map((row) => ({ ...row, author: assignees.get(row.submission_id)! }));
    artifact_comments = artifact_comments
      .filter((row) => keep(row.submission_id))
      .map((row) => ({ ...row, author: assignees.get(row.submission_id)! }));
    submission_comments = submission_comments
      .filter((row) => keep(row.submission_id))
      .map((row) => ({ ...row, author: assignees.get(row.submission_id)! }));
  }

  let sync_submission_ids = p.raw.sync_submission_ids;
  if (!sync_submission_ids?.length && p.raw.summary?.students?.length) {
    sync_submission_ids = p.raw.summary.students.map((s) => s.submission_id);
  } else if (!sync_submission_ids?.length && p.mode === "sync") {
    sync_submission_ids = Array.from(submissionIds);
  }

  if (skippedNoReviewAssignee.size > 0 && sync_submission_ids?.length) {
    sync_submission_ids = sync_submission_ids.filter((id) => !skippedNoReviewAssignee.has(id));
  }

  const payload: ImportCommentsPayload = {
    file_comments,
    artifact_comments,
    submission_comments,
    sync_submission_ids: sync_submission_ids ?? []
  };

  const rpcResult = await runCommentsImportOrSync(ctx, {
    class: p.class,
    assignment: p.assignment,
    payload,
    mode: p.mode,
    dry_run: p.dry_run
  });

  if (rpcResult.success && rpcResult.data && typeof rpcResult.data === "object" && skippedNoReviewAssignee.size > 0) {
    (rpcResult.data as Record<string, unknown>).skipped_without_review_assignee = Array.from(
      skippedNoReviewAssignee
    ).sort((a, b) => a - b);
  }

  return rpcResult;
}

async function handleArtifactsImport(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as SubmissionsArtifactsImportParams;
  if (!p.class) throw new CLICommandError("class is required");
  if (!p.assignment) throw new CLICommandError("assignment is required");
  if (!p.artifacts?.length) throw new CLICommandError("artifacts array is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  const assignment = await resolveAssignment(supabase, classData.id, p.assignment);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

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

    if (typeof art.content_base64 !== "string" || art.content_base64.length === 0) {
      errors.push({
        submission_id: art.submission_id,
        artifact_name: art.name,
        reason: "missing_content_base64"
      });
      continue;
    }

    if (dryRun) {
      const { data: existing, error: existingErr } = await findExistingArtifacts(supabase, art.submission_id, art.name);
      if (existingErr) {
        errors.push({ submission_id: art.submission_id, artifact_name: art.name, reason: existingErr });
        continue;
      }
      if (existing.length > 0 && !overwrite) skipped++;
      else if (existing.length > 0 && overwrite) overwritten++;
      else uploaded++;
      continue;
    }

    // Validated, not try/caught: Buffer.from(x, "base64") never throws. It silently
    // drops characters outside the alphabet, so the old guard was dead code and a
    // corrupt manifest uploaded truncated bytes and reported success. Re-encoding and
    // comparing is the cheap way to prove the input decoded losslessly.
    const bytes = decodeBase64Strict(art.content_base64);
    if (bytes === null) {
      errors.push({
        submission_id: art.submission_id,
        artifact_name: art.name,
        reason: "invalid_base64"
      });
      continue;
    }

    const { data: priorArtifacts, error: existingErr } = await findExistingArtifacts(
      supabase,
      art.submission_id,
      art.name
    );
    if (existingErr) {
      errors.push({ submission_id: art.submission_id, artifact_name: art.name, reason: existingErr });
      continue;
    }

    if (priorArtifacts.length > 0 && !overwrite) {
      skipped++;
      continue;
    }

    // The old artifact is deleted *after* the replacement is safely stored, further
    // down. Deleting first meant that when the upload failed we rolled back only the
    // new row, so the original artifact and all of its grading comments were already
    // gone — reported as one entry in errors[] under success: true. Two rows can
    // coexist here: submission_artifacts has no unique constraint on
    // (submission_id, name), only its primary key.
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
      // Roll back only the new row. The old artifact and its comments are still
      // intact because they have not been touched yet.
      await supabase.from("submission_artifacts").delete().eq("id", inserted.id);
      errors.push({
        submission_id: art.submission_id,
        artifact_name: art.name,
        reason: upErr.message
      });
      continue;
    }

    // The replacement is stored, so the old artifact can go. Errors here are
    // reported rather than discarded: a failure leaves a duplicate row behind, and
    // silently swallowing it is how `--overwrite` used to appear to work while
    // leaving the storage object orphaned.
    if (priorArtifacts.length > 0 && overwrite) {
      // Ordered comments → row → storage object, stopping at the first failure for a
      // given row, and repeated for *every* prior row so a run that follows a failed
      // cleanup reconciles the duplicate rather than adding to it.
      //
      // Deleting the object first was wrong in a way that compounds: a failed comment
      // delete leaves comments whose foreign key then blocks the row delete, so the old
      // artifact row survives pointing at a blob that no longer exists, and the grading
      // comments attached to it point at nothing. Removing the object last means every
      // failure leaves a *complete* old artifact — redundant, but coherent, and the
      // operator can retry.
      //
      // Every prior row is cleaned up, not just one. Because the insert now precedes the
      // delete and there is no unique index on (submission_id, name), an interrupted run
      // can leave duplicates behind; overwriting only the first would make `--overwrite`
      // a permanent no-op that adds a row each time it is invoked.
      const failCleanup = (priorId: number, reason: string) => {
        errors.push({
          submission_id: art.submission_id,
          artifact_name: art.name,
          reason: `replacement stored as artifact ${inserted.id}, but removing the previous artifact ${priorId} failed: ${reason}`
        });
      };

      let cleanupFailed = false;
      for (const prior of priorArtifacts) {
        const { error: commentsErr } = await supabase
          .from("submission_artifact_comments")
          .delete()
          .eq("submission_artifact_id", prior.id);
        if (commentsErr) {
          failCleanup(prior.id, commentsErr.message);
          cleanupFailed = true;
          continue;
        }

        const { error: rowErr } = await supabase.from("submission_artifacts").delete().eq("id", prior.id);
        if (rowErr) {
          failCleanup(prior.id, rowErr.message);
          cleanupFailed = true;
          continue;
        }

        const oldPath = `classes/${classData.id}/profiles/${profileSlot}/submissions/${art.submission_id}/${prior.id}`;
        const { error: objectErr } = await supabase.storage.from("submission-artifacts").remove([oldPath]);
        if (objectErr) {
          // The row is gone, so nothing references this blob any more. Reported so the
          // orphan can be swept, but the data model is consistent.
          failCleanup(prior.id, `its storage object was left behind: ${objectErr.message}`);
          cleanupFailed = true;
        }
      }

      if (cleanupFailed) continue;
      overwritten++;
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

async function handleSubmissionsExport(ctx: MCPAuthContext, rawParams: Record<string, unknown>): Promise<Response> {
  const params = rawParams as unknown as SubmissionsExportParams;
  const section: SubmissionsExportSection = params.section ?? "meta";
  if (!SUBMISSIONS_EXPORT_SECTIONS.has(section)) {
    throw new CLICommandError(
      `Invalid section: ${String(params.section)}. Must be one of: ${[...SUBMISSIONS_EXPORT_SECTIONS].join(", ")}`,
      400
    );
  }
  const mode = validateExportIdentityParams(params);

  if (!params.class) throw new CLICommandError("class is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, params.class);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

  const allSubmissions = params.all_submissions === true;
  const withBinary = params.with_binary === true;
  const includeFiles = normalizePatternList(params.include_files);
  const excludeFiles = normalizePatternList(params.exclude_files);
  const dumpId = params.dump_id ?? crypto.randomUUID();
  const tokenizer = mode === "raw" ? null : await createExportTokenizer(supabase, params.salt!);

  if (section === "catalog") {
    const { data: rows, error } = await supabase
      .from("assignments")
      .select("id, slug, title")
      .eq("class_id", classData.id)
      .order("id", { ascending: true });
    if (error) throw new CLICommandError(`Failed to load assignments: ${error.message}`, 500);

    const candidates = (rows ?? []).map((r) => ({ id: r.id, slug: r.slug, title: r.title }));
    const selectors = params.assignments ?? (params.assignment != null ? [params.assignment] : undefined);
    const { resolved, unmatched } = resolveSelectors(selectors, candidates);

    return streamNdjson(async (writer) => {
      for (const row of resolved) {
        await writer.write({
          kind: "assignment",
          id: row.id,
          slug: row.slug,
          title: row.title
        });
      }
      for (const sel of unmatched) {
        await writer.write({
          kind: "warning",
          scope: "assignments",
          message: "selector_matched_no_assignments",
          selectors: [sel]
        });
      }
      await writer.write({
        kind: "end",
        counts: { assignments: resolved.length },
        unmatched_selectors: unmatched
      });
    });
  }

  if (!params.assignment) throw new CLICommandError("assignment is required for section=meta|files");

  const assignment = await resolveAssignment(supabase, classData.id, params.assignment);

  if (section === "meta") {
    return streamNdjson(async (writer) => {
      await writer.write({
        kind: "manifest",
        schema_version: SUBMISSIONS_EXPORT_SCHEMA_VERSION,
        identity_mode: mode,
        dump_id: dumpId,
        exported_at: new Date().toISOString(),
        class: classSummary(classData),
        assignment: { id: assignment.id, slug: assignment.slug, title: assignment.title },
        submissions_scope: allSubmissions ? "all" : "active",
        with_binary: withBinary,
        ...(includeFiles.length > 0 ? { include_files: includeFiles } : {}),
        ...(excludeFiles.length > 0 ? { exclude_files: excludeFiles } : {}),
        privacy_notes: SUBMISSIONS_EXPORT_PRIVACY_NOTES
      });

      const { submissionCount, submissionIds } = await streamSubmissions(
        supabase,
        assignment.id,
        allSubmissions,
        mode,
        tokenizer,
        writer,
        { includeOrdinal: true }
      );

      await writer.write({
        kind: "end",
        counts: { submissions: submissionCount },
        submission_ids: submissionIds
      });
    });
  }

  if (section === "files") {
    const rawSubmissionIds = params.submission_ids;
    if (!Array.isArray(rawSubmissionIds) || rawSubmissionIds.length === 0) {
      throw new CLICommandError("submission_ids is required for section=files", 400);
    }

    const requestedIds = [...new Set(rawSubmissionIds.map((id) => Number(id)))];
    if (requestedIds.some((id) => !Number.isInteger(id) || id < 1)) {
      throw new CLICommandError("submission_ids must all be positive integers", 400);
    }

    // Scope the caller's ids to the class and assignment they were authorized for.
    //
    // Without this the only predicate downstream is `.in("submission_id", ids)` on
    // the service-role client, so anyone holding cli:read in a single class could
    // pass ids belonging to any other class and receive full submission_files
    // contents — student source code — for the whole deployment. Submission ids
    // are sequential, so enumeration is trivial. `assignment` was already
    // resolved here but never applied to the query.
    const ownedIds: number[] = [];
    for (let i = 0; i < requestedIds.length; i += 500) {
      const batch = requestedIds.slice(i, i + 500);
      const rows = await pageAll<{ id: number }>(
        () =>
          supabase
            .from("submissions")
            .select("id")
            .eq("class_id", classData.id)
            .eq("assignment_id", assignment.id)
            .in("id", batch)
            .order("id", { ascending: true }),
        "Failed to validate submission_ids"
      );
      ownedIds.push(...rows.map((r) => r.id));
    }

    const ownedSet = new Set(ownedIds);
    const foreignIds = requestedIds.filter((id) => !ownedSet.has(id));
    if (foreignIds.length > 0) {
      throw new CLICommandError(
        `These submission ids do not belong to assignment ${assignment.id} in class ${classData.id}: ` +
          foreignIds.slice(0, 20).join(", ") +
          (foreignIds.length > 20 ? ` (and ${foreignIds.length - 20} more)` : ""),
        400
      );
    }

    const submissionIds = ownedIds;
    const rawBatchIndex = params.files_batch_index ?? 0;
    if (!Number.isInteger(Number(rawBatchIndex)) || Number(rawBatchIndex) < 0) {
      throw new CLICommandError("files_batch_index must be a non-negative integer", 400);
    }
    const filesBatchIndex = Number(rawBatchIndex);

    return streamNdjson(async (writer) => {
      const { fileCount, nextFilesBatchIndex } = await streamSubmissionFiles(supabase, tokenizer, writer, {
        withBinary,
        filesBatchIndex,
        submissionIds,
        includeFiles: includeFiles.length > 0 ? includeFiles : undefined,
        excludeFiles: excludeFiles.length > 0 ? excludeFiles : undefined
      });

      await writer.write({
        kind: "end",
        counts: { files: fileCount },
        ...(nextFilesBatchIndex !== null ? { next_files_batch_index: nextFilesBatchIndex } : {})
      });
    });
  }

  throw new CLICommandError(`invalid section: ${String(section)}`, 400);
}

function normalizePatternList(raw: string[] | undefined): string[] {
  if (!raw) return [];
  return raw.map((p) => p.trim()).filter((p) => p.length > 0);
}

const SUBMISSIONS_LIST_PAGE = 1000;
const SUBMISSIONS_LIST_DEFAULT_LIMIT = 1000;
const SUBMISSIONS_LIST_MAX_LIMIT = 10000;

interface SubmissionsListParams {
  class?: string | number;
  assignment?: string | number;
  limit?: number;
  /** Include enrolled students who have no submission (activesubmissionid is null). */
  include_non_submitters?: boolean;
}

/**
 * submissions.list — the roster-plus-grades view the instructor submissions
 * page renders.
 *
 * Two properties of `submissions_with_grades_for_assignment_nice` shape this
 * handler (see supabase/migrations/20260716000000_roster_placeholder_flag.sql):
 *
 *   - It emits one row per *enrolled student*, not per submission. `id` is the
 *     `user_roles.id`, so the submission is `activesubmissionid`. Members of a
 *     group therefore produce several rows sharing one `activesubmissionid`;
 *     we keep them all (one line per student is what an operator wants) and
 *     report the distinct submission count separately.
 *   - A student with no submission still gets a row, with a null
 *     `activesubmissionid`. Those are excluded unless asked for, so the
 *     default output lists work that exists.
 *
 * `is_placeholder` marks a manually created submission (`submitted_via =
 * 'manual'`), which is unrelated to whether the student submitted.
 */
async function handleSubmissionsList(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as SubmissionsListParams;
  if (!p.class) throw new CLICommandError("class is required");
  if (!p.assignment) throw new CLICommandError("assignment is required");

  const limit = p.limit === undefined || p.limit === null ? SUBMISSIONS_LIST_DEFAULT_LIMIT : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CLICommandError(`limit must be a positive integer (got ${String(p.limit)})`, 400);
  }
  if (limit > SUBMISSIONS_LIST_MAX_LIMIT) {
    throw new CLICommandError(
      `limit must be ${SUBMISSIONS_LIST_MAX_LIMIT} or less (got ${limit}). A class roster does not exceed that.`,
      400
    );
  }

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);
  const assignment = await resolveAssignment(supabase, classData.id, p.assignment);

  // One row past `limit`, used only to answer "is there more?" and then dropped.
  // `.range()` can never return more than it asks for, so testing `rows.length >= limit`
  // reported an exactly-full final page as truncated.
  const probeLimit = limit + 1;
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; rows.length < probeLimit; offset += SUBMISSIONS_LIST_PAGE) {
    const page = Math.min(SUBMISSIONS_LIST_PAGE, probeLimit - rows.length);
    let query = supabase
      .from("submissions_with_grades_for_assignment_nice")
      .select(
        "id, activesubmissionid, ordinal, name, sortable_name, groupname, student_private_profile_id, " +
          "sha, repository, autograder_score, total_score, tweak, released, tokens_consumed, hours, " +
          "due_date, late_due_date, gradername, assignedgradername, completed_at, checkername, " +
          "class_section_name, lab_section_name, is_placeholder, created_at, assignment_group_id, " +
          "per_student_grading_totals, individual_scores"
      )
      .eq("class_id", classData.id)
      .eq("assignment_id", assignment.id);

    if (!p.include_non_submitters) {
      query = query.not("activesubmissionid", "is", null);
    }

    const { data, error } = await query
      .order("sortable_name", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + page - 1);

    if (error) {
      throw new CLICommandError(`Failed to list submissions: ${error.message}`, 500);
    }

    const batch = (data ?? []) as unknown as Array<Record<string, unknown>>;
    rows.push(...batch);
    if (batch.length < page) break;
  }

  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;

  // `total_score` on this view is the review's shared total. For rubrics with
  // individually graded or per-student-assigned parts, the authoritative figure
  // for a roster row is that student's entry in per_student_grading_totals (or
  // the legacy individual_scores), which is what the instructor table shows.
  // Reporting the shared value for every group member would misstate individual
  // students, so the resolved figure is exposed as student_total_score.
  const submissions = rows.map((r) => ({
    ...r,
    /**
     * The deadline this student is actually held to: the view's `late_due_date` is
     * `due_date` plus the `hours` of extension granted to them, not a separate grace
     * period, and naming it "late" invited reading it as one.
     */
    effective_due_date: r.late_due_date ?? r.due_date ?? null,
    student_total_score: gradingTotalForStudent(
      {
        total_score: (r.total_score as number | null) ?? null,
        per_student_grading_totals: r.per_student_grading_totals,
        individual_scores: r.individual_scores
      },
      r.student_private_profile_id as string | null
    )
  }));

  const distinctSubmissions = new Set(
    rows.map((r) => r.activesubmissionid).filter((id): id is number => typeof id === "number")
  );

  // Counted with its own query rather than from `rows`. The default fetch filters
  // non-submitters out, so counting them in the result was structurally always zero;
  // and even with --include-non-submitters the count would describe the page rather
  // than the class as soon as `limit` bit.
  const { count: nonSubmitterCount, error: nonSubmitterError } = await supabase
    .from("submissions_with_grades_for_assignment_nice")
    .select("id", { count: "exact", head: true })
    .eq("class_id", classData.id)
    .eq("assignment_id", assignment.id)
    .is("activesubmissionid", null);
  if (nonSubmitterError) {
    throw new CLICommandError(`Failed to count non-submitters: ${nonSubmitterError.message}`, 500);
  }

  return {
    success: true,
    data: {
      class: classSummary(classData),
      assignment: {
        id: assignment.id,
        slug: assignment.slug,
        title: assignment.title,
        due_date: assignment.due_date,
        total_points: assignment.total_points
      },
      submissions,
      summary: {
        rows: rows.length,
        distinct_submissions: distinctSubmissions.size,
        /** Enrolled students with no active submission, across the whole assignment. */
        non_submitters: nonSubmitterCount ?? 0,
        /** Non-submitters present in `submissions`; zero unless --include-non-submitters. */
        non_submitters_listed: rows.filter((r) => r.activesubmissionid == null).length,
        truncated
      }
    }
  };
}

registerCommand({
  name: "submissions.list",
  requiredScope: "cli:read",
  handler: handleSubmissionsList
});

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

registerCommand({
  name: "submissions.export",
  requiredScope: "cli:read",
  stream: true,
  handler: handleSubmissionsExport
});
