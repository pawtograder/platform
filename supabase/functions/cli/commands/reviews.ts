/**
 * reviews.* CLI commands — reviews.list (cli:read), reviews.assign (cli:write).
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import type { Json } from "../../_shared/SupabaseTypes.d.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveClass, resolveAssignment, resolveRubricIdForType, RUBRIC_TYPES } from "../utils/resolvers.ts";
import { assertUserCanAccessClass, assertUserIsClassInstructor } from "../utils/auth.ts";
import { allocateRoundRobin, summarizeLoad, type DraftAssignment } from "../utils/reviewAllocation.ts";
import { CLICommandError } from "../errors.ts";
import type { AssignmentRow, CLIResponse } from "../types.ts";

const PAGE = 1000;
const DEFAULT_LIST_LIMIT = 1000;

interface ReviewsListParams {
  class?: string | number;
  assignment?: string | number;
  rubric?: string | number;
  assignee?: string;
  status?: string;
  limit?: number;
}

interface ReviewsAssignParams {
  class?: string | number;
  assignment?: string | number;
  rubric?: string | number;
  due_date?: string;
  /** Explicit staff private profile ids to draw from; defaults to all class staff. */
  graders?: string[];
  /** Fan out one assignment per rubric part instead of one per submission. */
  by_part?: boolean;
  /** Explicit assignment list, bypassing round-robin allocation. */
  drafts?: unknown;
  dry_run?: boolean;
}

/**
 * Resolves `rubric` which may be a type name (`grading`, `self_review`, `meta`)
 * or a numeric rubric id belonging to the assignment.
 */
async function resolveRubricParam(
  supabase: ReturnType<typeof getAdminClient>,
  assignment: AssignmentRow,
  raw: string | number | undefined
): Promise<number> {
  const value = raw === undefined || raw === null || String(raw).trim() === "" ? "grading" : String(raw).trim();

  if (/^\d+$/.test(value)) {
    const rubricId = Number(value);
    const { data, error } = await supabase.from("rubrics").select("id, assignment_id").eq("id", rubricId).maybeSingle();
    if (error) throw new CLICommandError(`Failed to resolve rubric: ${error.message}`, 500);
    if (!data || data.assignment_id !== assignment.id) {
      throw new CLICommandError(`Rubric ${rubricId} does not belong to assignment ${assignment.id}`, 400);
    }
    return rubricId;
  }

  if (!(RUBRIC_TYPES as string[]).includes(value)) {
    throw new CLICommandError(`Invalid rubric: ${value}. Pass a rubric id or one of ${RUBRIC_TYPES.join(", ")}`, 400);
  }

  const rubricId = resolveRubricIdForType(assignment, value);
  if (!rubricId) {
    throw new CLICommandError(`Assignment ${assignment.slug ?? assignment.id} has no ${value} rubric`, 400);
  }
  return rubricId;
}

/** Every review_assignment for an assignment, paged. */
async function fetchReviewAssignments(
  supabase: ReturnType<typeof getAdminClient>,
  assignmentId: number,
  rubricId: number | null,
  limit: number
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let offset = 0; out.length < limit; offset += PAGE) {
    const page = Math.min(PAGE, limit - out.length);
    let query = supabase
      .from("review_assignments")
      .select(
        "id, class_id, assignment_id, assignee_profile_id, submission_id, submission_review_id, rubric_id, " +
          "due_date, release_date, hard_deadline, max_allowable_late_tokens, completed_at, completed_by, created_at, " +
          "review_assignment_rubric_parts(rubric_part_id, " +
          "rubric_parts!review_assignment_rubric_parts_rubric_part_id_fkey(id, name)), " +
          "submission_reviews(id, name, completed_at, total_score, released), " +
          "submissions(id, ordinal, is_active, profile_id, assignment_group_id)"
      )
      .eq("assignment_id", assignmentId);

    if (rubricId !== null) query = query.eq("rubric_id", rubricId);

    const { data, error } = await query.order("id", { ascending: true }).range(offset, offset + page - 1);

    if (error) throw new CLICommandError(`Failed to list review assignments: ${error.message}`, 500);

    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

/** Batched private-profile-id → display name lookup. */
async function fetchProfileNames(
  supabase: ReturnType<typeof getAdminClient>,
  ids: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return names;

  const BATCH = 500;
  for (let i = 0; i < unique.length; i += BATCH) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, name")
      .in("id", unique.slice(i, i + BATCH));
    if (error) throw new CLICommandError(`Failed to resolve profile names: ${error.message}`, 500);
    for (const row of data ?? []) {
      if (row.name) names.set(row.id, row.name);
    }
  }
  return names;
}

async function handleReviewsList(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as ReviewsListParams;
  if (!p.class) throw new CLICommandError("class is required");
  if (!p.assignment) throw new CLICommandError("assignment is required");

  const status = p.status ?? "all";
  if (!["pending", "completed", "all"].includes(status)) {
    throw new CLICommandError(`Invalid status: ${status}. Must be pending, completed, or all`, 400);
  }

  const limit = p.limit === undefined || p.limit === null ? DEFAULT_LIST_LIMIT : Math.floor(Number(p.limit));
  if (!Number.isFinite(limit) || limit < 1) throw new CLICommandError("limit must be a positive integer", 400);

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);
  const assignment = await resolveAssignment(supabase, classData.id, p.assignment);

  // `rubric` is optional here: omitting it lists every round.
  const rubricId =
    p.rubric === undefined || p.rubric === null || String(p.rubric).trim() === ""
      ? null
      : await resolveRubricParam(supabase, assignment, p.rubric);

  const rows = await fetchReviewAssignments(supabase, assignment.id, rubricId, limit);

  const names = await fetchProfileNames(supabase, [
    ...rows.map((r) => r.assignee_profile_id as string | null),
    ...rows.map((r) => r.completed_by as string | null)
  ]);

  let reviews = rows.map((r) => {
    const parts = (r.review_assignment_rubric_parts ?? []) as Array<{
      rubric_part_id: number;
      rubric_parts?: { id: number; name: string } | null;
    }>;
    const submission = r.submissions as { id: number; ordinal: number; is_active: boolean } | null;
    const review = r.submission_reviews as { completed_at: string | null; total_score: number | null } | null;

    return {
      id: r.id,
      assignee_profile_id: r.assignee_profile_id,
      assignee_name: names.get(r.assignee_profile_id as string) ?? null,
      submission_id: r.submission_id,
      submission_ordinal: submission?.ordinal ?? null,
      submission_is_active: submission?.is_active ?? null,
      submission_review_id: r.submission_review_id,
      rubric_id: r.rubric_id,
      rubric_part_ids: parts.map((part) => part.rubric_part_id),
      rubric_part_names: parts.map((part) => part.rubric_parts?.name ?? String(part.rubric_part_id)),
      due_date: r.due_date,
      release_date: r.release_date,
      hard_deadline: r.hard_deadline,
      completed_at: r.completed_at,
      completed_by: r.completed_by,
      completed_by_name: r.completed_by ? (names.get(r.completed_by as string) ?? null) : null,
      review_total_score: review?.total_score ?? null,
      review_completed_at: review?.completed_at ?? null
    };
  });

  if (p.assignee) {
    const needle = String(p.assignee).trim().toLowerCase();
    reviews = reviews.filter(
      (r) =>
        String(r.assignee_profile_id).toLowerCase() === needle || (r.assignee_name ?? "").toLowerCase().includes(needle)
    );
  }

  if (status === "pending") reviews = reviews.filter((r) => r.completed_at == null);
  if (status === "completed") reviews = reviews.filter((r) => r.completed_at != null);

  return {
    success: true,
    data: {
      class: { id: classData.id, slug: classData.slug, name: classData.name },
      assignment: { id: assignment.id, slug: assignment.slug, title: assignment.title },
      rubric_id: rubricId,
      reviews,
      summary: {
        total: reviews.length,
        completed: reviews.filter((r) => r.completed_at != null).length,
        pending: reviews.filter((r) => r.completed_at == null).length,
        truncated: rows.length >= limit
      }
    }
  };
}

/** Validates a caller-supplied manifest into draft assignments. */
function parseDraftManifest(raw: unknown): DraftAssignment[] {
  if (!Array.isArray(raw)) {
    throw new CLICommandError("drafts must be an array of {assignee_profile_id, submission_id, rubric_part_id}", 400);
  }

  const allowed = new Set(["assignee_profile_id", "submission_id", "rubric_part_id"]);
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new CLICommandError(`drafts[${index}] must be an object`, 400);
    }
    const record = entry as Record<string, unknown>;

    const unknownKeys = Object.keys(record).filter((k) => !allowed.has(k));
    if (unknownKeys.length > 0) {
      throw new CLICommandError(`drafts[${index}] has unsupported key(s): ${unknownKeys.join(", ")}`, 400);
    }

    const assignee = record.assignee_profile_id;
    if (typeof assignee !== "string" || assignee.trim() === "") {
      throw new CLICommandError(`drafts[${index}].assignee_profile_id must be a profile UUID`, 400);
    }

    const submissionId = Math.floor(Number(record.submission_id));
    if (!Number.isFinite(submissionId) || submissionId < 1) {
      throw new CLICommandError(`drafts[${index}].submission_id must be a positive integer`, 400);
    }

    let rubricPartId: number | null = null;
    if (record.rubric_part_id !== undefined && record.rubric_part_id !== null) {
      rubricPartId = Math.floor(Number(record.rubric_part_id));
      if (!Number.isFinite(rubricPartId) || rubricPartId < 1) {
        throw new CLICommandError(`drafts[${index}].rubric_part_id must be a positive integer or null`, 400);
      }
    }

    return { assignee_profile_id: assignee.trim(), submission_id: submissionId, rubric_part_id: rubricPartId };
  });
}

/**
 * reviews.assign — creates grading assignments through the `bulk_assign_reviews`
 * RPC, the same entry point the bulk-assign page uses.
 *
 * The RPC does the heavy lifting: it validates assignment/rubric/part/submission
 * relationships, upserts `submission_reviews`, reuses existing
 * `review_assignments` rather than duplicating them, and retargets assignments
 * that point at superseded submissions. It also enforces instructor access via
 * `authorizeforclassinstructor`, which needs the caller's identity — hence
 * `ctx.supabase` (the short-lived per-user client) rather than the service-role
 * admin client used for the read queries below.
 */
async function handleReviewsAssign(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as ReviewsAssignParams;
  if (!p.class) throw new CLICommandError("class is required");
  if (!p.assignment) throw new CLICommandError("assignment is required");
  if (!p.due_date) throw new CLICommandError("due_date is required");

  const dueDate = new Date(p.due_date);
  if (Number.isNaN(dueDate.getTime())) {
    throw new CLICommandError(`due_date is not a valid date: ${p.due_date}`, 400);
  }

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  await assertUserIsClassInstructor(supabase, ctx.userId, classData.id);
  const assignment = await resolveAssignment(supabase, classData.id, p.assignment);
  const rubricId = await resolveRubricParam(supabase, assignment, p.rubric);

  // ── Staff pool ───────────────────────────────────────────────────────────
  // bulk_assign_reviews rejects any assignee who is not a grader or instructor
  // in the class, so the pool is drawn from those roles only.
  const { data: staffRoles, error: staffError } = await supabase
    .from("user_roles")
    .select("private_profile_id, role")
    .eq("class_id", classData.id)
    .eq("disabled", false)
    .in("role", ["grader", "instructor"]);
  if (staffError) throw new CLICommandError(`Failed to load class staff: ${staffError.message}`, 500);

  const staffProfileIds = new Set((staffRoles ?? []).map((r) => r.private_profile_id));

  let drafts: DraftAssignment[];
  let allocation: ReturnType<typeof allocateRoundRobin> | null = null;

  if (p.drafts !== undefined && p.drafts !== null) {
    drafts = parseDraftManifest(p.drafts);
    if (drafts.length === 0) throw new CLICommandError("drafts is empty; nothing to assign", 400);

    // Validate up front so a typo fails with a clear message instead of the
    // RPC's generic failure after partial work.
    const badAssignees = [...new Set(drafts.map((d) => d.assignee_profile_id))].filter(
      (id) => !staffProfileIds.has(id)
    );
    if (badAssignees.length > 0) {
      throw new CLICommandError(
        `These assignees are not active graders/instructors in the class: ${badAssignees.join(", ")}`,
        400
      );
    }

    const submissionIds = [...new Set(drafts.map((d) => d.submission_id))];
    const { data: validSubmissions, error: submissionError } = await supabase
      .from("submissions")
      .select("id")
      .eq("assignment_id", assignment.id)
      .in("id", submissionIds);
    if (submissionError) throw new CLICommandError(`Failed to validate submissions: ${submissionError.message}`, 500);

    const validIds = new Set((validSubmissions ?? []).map((s) => s.id));
    const badSubmissions = submissionIds.filter((id) => !validIds.has(id));
    if (badSubmissions.length > 0) {
      throw new CLICommandError(
        `These submission ids do not belong to assignment ${assignment.id}: ${badSubmissions.join(", ")}`,
        400
      );
    }

    const partIds = [...new Set(drafts.map((d) => d.rubric_part_id).filter((id): id is number => id != null))];
    if (partIds.length > 0) {
      const { data: validParts, error: partError } = await supabase
        .from("rubric_parts")
        .select("id")
        .eq("rubric_id", rubricId)
        .in("id", partIds);
      if (partError) throw new CLICommandError(`Failed to validate rubric parts: ${partError.message}`, 500);
      const validPartIds = new Set((validParts ?? []).map((r) => r.id));
      const badParts = partIds.filter((id) => !validPartIds.has(id));
      if (badParts.length > 0) {
        throw new CLICommandError(
          `These rubric part ids do not belong to rubric ${rubricId}: ${badParts.join(", ")}`,
          400
        );
      }
    }
  } else {
    // ── Round-robin allocation ─────────────────────────────────────────────
    let pool = [...staffProfileIds];
    if (p.graders && p.graders.length > 0) {
      const requested = p.graders.map((g) => String(g).trim()).filter((g) => g !== "");
      const unknown = requested.filter((g) => !staffProfileIds.has(g));
      if (unknown.length > 0) {
        throw new CLICommandError(
          `These graders are not active graders/instructors in the class: ${unknown.join(", ")}`,
          400
        );
      }
      pool = requested;
    }
    if (pool.length === 0) {
      throw new CLICommandError("No active graders or instructors in this class to assign work to", 400);
    }

    const { data: submissions, error: submissionError } = await supabase
      .from("submissions")
      .select("id, profile_id, assignment_group_id")
      .eq("assignment_id", assignment.id)
      .eq("is_active", true);
    if (submissionError) throw new CLICommandError(`Failed to load submissions: ${submissionError.message}`, 500);
    if (!submissions || submissions.length === 0) {
      throw new CLICommandError(`Assignment ${assignment.id} has no active submissions to assign`, 400);
    }

    let rubricPartIds: number[] | null = null;
    if (p.by_part === true) {
      const { data: parts, error: partError } = await supabase
        .from("rubric_parts")
        .select("id")
        .eq("rubric_id", rubricId)
        .order("ordinal", { ascending: true });
      if (partError) throw new CLICommandError(`Failed to load rubric parts: ${partError.message}`, 500);
      if (!parts || parts.length === 0) {
        throw new CLICommandError(`Rubric ${rubricId} has no parts to fan out over`, 400);
      }
      rubricPartIds = parts.map((part) => part.id);
    }

    const existingRows = await fetchReviewAssignments(supabase, assignment.id, rubricId, DEFAULT_LIST_LIMIT * 10);
    const existing: DraftAssignment[] = [];
    for (const row of existingRows) {
      const parts = (row.review_assignment_rubric_parts ?? []) as Array<{ rubric_part_id: number }>;
      if (parts.length === 0) {
        existing.push({
          assignee_profile_id: row.assignee_profile_id as string,
          submission_id: row.submission_id as number,
          rubric_part_id: null
        });
      } else {
        for (const part of parts) {
          existing.push({
            assignee_profile_id: row.assignee_profile_id as string,
            submission_id: row.submission_id as number,
            rubric_part_id: part.rubric_part_id
          });
        }
      }
    }

    const excludedBySubmission = await buildConflictExclusions(supabase, classData.id, submissions);

    allocation = allocateRoundRobin({
      submissionIds: submissions.map((s) => s.id),
      assigneeProfileIds: pool,
      rubricPartIds,
      existing,
      excludedBySubmission
    });
    drafts = allocation.drafts;
  }

  const response = {
    class: { id: classData.id, slug: classData.slug, name: classData.name },
    assignment: { id: assignment.id, slug: assignment.slug, title: assignment.title },
    rubric_id: rubricId,
    due_date: dueDate.toISOString(),
    drafts,
    load: summarizeLoad(drafts),
    skipped_already_assigned: allocation?.skippedAlreadyAssigned ?? 0,
    unassignable: allocation?.unassignable ?? []
  };

  if (p.dry_run === true) {
    return { success: true, data: { ...response, dry_run: true } };
  }

  if (drafts.length === 0) {
    return {
      success: true,
      data: {
        ...response,
        dry_run: false,
        result: null,
        message: "Nothing to assign — every submission already has an assignee for this rubric."
      }
    };
  }

  const { data: rpcResult, error: rpcError } = await ctx.supabase.rpc("bulk_assign_reviews", {
    p_class_id: classData.id,
    p_assignment_id: assignment.id,
    p_rubric_id: rubricId,
    p_draft_assignments: drafts as unknown as Json,
    p_due_date: dueDate.toISOString()
  });

  if (rpcError) {
    throw new CLICommandError(`bulk_assign_reviews failed: ${rpcError.message}`, 500);
  }

  // The RPC traps its own exceptions and reports them in the payload, so a
  // missing PostgREST error does not mean the work succeeded.
  const result = (rpcResult ?? {}) as { success?: boolean; error?: string; error_code?: string };
  if (result.success !== true) {
    throw new CLICommandError(
      `bulk_assign_reviews reported failure: ${result.error ?? "unknown error"}${
        result.error_code ? ` (${result.error_code})` : ""
      }`,
      400
    );
  }

  return { success: true, data: { ...response, dry_run: false, result: rpcResult } };
}

/**
 * Reviewers who must not be given a given submission.
 *
 * Two sources: `grading_conflicts`, which the bulk-assign UI treats as hard
 * exclusions, and the submitters themselves, so nobody is handed their own work
 * when a staff member is also enrolled.
 */
async function buildConflictExclusions(
  supabase: ReturnType<typeof getAdminClient>,
  classId: number,
  submissions: Array<{ id: number; profile_id: string | null; assignment_group_id: number | null }>
): Promise<Map<number, Set<string>>> {
  const excluded = new Map<number, Set<string>>();

  // submission -> the students it belongs to (individual or all group members).
  const submitters = new Map<number, Set<string>>();
  const groupIds = [...new Set(submissions.map((s) => s.assignment_group_id).filter((id): id is number => id != null))];

  const groupMembers = new Map<number, string[]>();
  if (groupIds.length > 0) {
    const { data, error } = await supabase
      .from("assignment_groups_members")
      .select("assignment_group_id, profile_id")
      .in("assignment_group_id", groupIds);
    if (error) throw new CLICommandError(`Failed to load group members: ${error.message}`, 500);
    for (const row of data ?? []) {
      const list = groupMembers.get(row.assignment_group_id) ?? [];
      list.push(row.profile_id);
      groupMembers.set(row.assignment_group_id, list);
    }
  }

  for (const s of submissions) {
    const owners = new Set<string>();
    if (s.profile_id) owners.add(s.profile_id);
    if (s.assignment_group_id != null) {
      for (const member of groupMembers.get(s.assignment_group_id) ?? []) owners.add(member);
    }
    submitters.set(s.id, owners);
  }

  const { data: conflicts, error: conflictError } = await supabase
    .from("grading_conflicts")
    .select("grader_profile_id, student_profile_id")
    .eq("class_id", classId);
  if (conflictError) throw new CLICommandError(`Failed to load grading conflicts: ${conflictError.message}`, 500);

  // student -> graders barred from grading them.
  const conflictsByStudent = new Map<string, string[]>();
  for (const c of conflicts ?? []) {
    const list = conflictsByStudent.get(c.student_profile_id) ?? [];
    list.push(c.grader_profile_id);
    conflictsByStudent.set(c.student_profile_id, list);
  }

  for (const [submissionId, owners] of submitters) {
    const set = new Set<string>();
    for (const owner of owners) {
      // A staff member who is also a submitter must not review their own work.
      set.add(owner);
      for (const grader of conflictsByStudent.get(owner) ?? []) set.add(grader);
    }
    if (set.size > 0) excluded.set(submissionId, set);
  }

  return excluded;
}

registerCommand({
  name: "reviews.list",
  requiredScope: "cli:read",
  handler: handleReviewsList
});

registerCommand({
  name: "reviews.assign",
  requiredScope: "cli:write",
  handler: handleReviewsAssign
});
