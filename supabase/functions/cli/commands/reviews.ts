/**
 * reviews.* CLI commands — reviews.list (cli:read), reviews.assign (cli:write).
 */

import { createAuthenticatedSupabaseClient, type MCPAuthContext } from "../../_shared/MCPAuth.ts";
import type { Json } from "../../_shared/SupabaseTypes.d.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveClass, resolveAssignment, resolveRubricIdForType, RUBRIC_TYPES } from "../utils/resolvers.ts";
import { assertUserCanAccessClass, assertUserIsClassInstructor } from "../utils/auth.ts";
import {
  activeSubmissionFor,
  allocateRoundRobin,
  buildActiveSubmissionIndex,
  summarizeLoad,
  type DraftAssignment
} from "../utils/reviewAllocation.ts";
import { resolveDueDate } from "../utils/zonedDate.ts";
import { pageAll } from "../utils/paging.ts";
import { CLICommandError } from "../errors.ts";
import type { AssignmentRow, CLIResponse } from "../types.ts";

const PAGE = 1000;
/** Sentinel for fetchReviewAssignments: page until the table is exhausted. */
const FETCH_ALL = Number.POSITIVE_INFINITY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 5000;

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

export interface ReviewAssignmentFilters {
  rubricId?: number | null;
  /** Completion state; `completed_at` lives on review_assignments. */
  status?: "pending" | "completed" | "all";
  /** Restrict to these assignee profile ids. */
  assigneeProfileIds?: string[] | null;
}

/**
 * Every review_assignment for an assignment matching `filters`, paged.
 *
 * Filters are applied in Postgres rather than to the fetched page. Applying them
 * afterwards meant `--status pending --limit 1000` returned nothing when the
 * first thousand rows happened to be completed — the limit selected the slice
 * before the predicate ever ran.
 */
async function fetchReviewAssignments(
  supabase: ReturnType<typeof getAdminClient>,
  assignmentId: number,
  limit: number,
  filters: ReviewAssignmentFilters = {}
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

    if (filters.rubricId !== null && filters.rubricId !== undefined) {
      query = query.eq("rubric_id", filters.rubricId);
    }
    if (filters.status === "pending") query = query.is("completed_at", null);
    if (filters.status === "completed") query = query.not("completed_at", "is", null);
    if (filters.assigneeProfileIds) query = query.in("assignee_profile_id", filters.assigneeProfileIds);

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

  const limit = p.limit === undefined || p.limit === null ? DEFAULT_LIST_LIMIT : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CLICommandError(`limit must be a positive integer (got ${String(p.limit)})`, 400);
  }
  // Bounded rather than clamped, matching help_requests.list: an unbounded limit
  // pages the whole table through the edge function.
  if (limit > MAX_LIST_LIMIT) {
    throw new CLICommandError(
      `limit must be ${MAX_LIST_LIMIT} or less (got ${limit}). Narrow the results with --status, --assignee, or --rubric.`,
      400
    );
  }

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);
  const assignment = await resolveAssignment(supabase, classData.id, p.assignment);

  // `rubric` is optional here: omitting it lists every round.
  const rubricId =
    p.rubric === undefined || p.rubric === null || String(p.rubric).trim() === ""
      ? null
      : await resolveRubricParam(supabase, assignment, p.rubric);

  // Resolve --assignee to concrete profile ids up front so the filter can run in
  // Postgres. A bare UUID is used directly; anything else is matched against
  // staff names in this class.
  let assigneeProfileIds: string[] | null = null;
  if (p.assignee && String(p.assignee).trim() !== "") {
    const needle = String(p.assignee).trim();
    if (UUID_RE.test(needle)) {
      assigneeProfileIds = [needle];
    } else {
      const { data: matches, error: matchError } = await supabase
        .from("profiles")
        .select("id, name")
        .eq("class_id", classData.id)
        .ilike("name", `%${needle}%`);
      if (matchError) throw new CLICommandError(`Failed to resolve assignee: ${matchError.message}`, 500);
      assigneeProfileIds = (matches ?? []).map((m) => m.id);
      if (assigneeProfileIds.length === 0) {
        throw new CLICommandError(`No one in this class matches assignee "${needle}"`, 404);
      }
    }
  }

  const rows = await fetchReviewAssignments(supabase, assignment.id, limit, {
    rubricId,
    status: status as "pending" | "completed" | "all",
    assigneeProfileIds
  });

  const names = await fetchProfileNames(supabase, [
    ...rows.map((r) => r.assignee_profile_id as string | null),
    ...rows.map((r) => r.completed_by as string | null)
  ]);

  const reviews = rows.map((r) => {
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

    // Not floored: 123.4 would become a real but unintended submission, and this
    // path writes grading assignments.
    const submissionId = Number(record.submission_id);
    if (!Number.isInteger(submissionId) || submissionId < 1) {
      throw new CLICommandError(
        `drafts[${index}].submission_id must be a positive integer (got ${String(record.submission_id)})`,
        400
      );
    }

    let rubricPartId: number | null = null;
    if (record.rubric_part_id !== undefined && record.rubric_part_id !== null) {
      rubricPartId = Number(record.rubric_part_id);
      if (!Number.isInteger(rubricPartId) || rubricPartId < 1) {
        throw new CLICommandError(
          `drafts[${index}].rubric_part_id must be a positive integer or null (got ${String(record.rubric_part_id)})`,
          400
        );
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

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, p.class);
  await assertUserIsClassInstructor(supabase, ctx.userId, classData.id);

  // Resolved after the class, because a date-only deadline has to be read in the
  // class's time zone. Parsing it as UTC put a New York course's deadline on the
  // previous evening.
  let dueDateIso: string;
  try {
    dueDateIso = resolveDueDate(String(p.due_date), classData.time_zone);
  } catch (err) {
    throw new CLICommandError(err instanceof Error ? err.message : `Invalid due_date: ${String(p.due_date)}`, 400);
  }
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
  let retargetCount = 0;
  /** review_assignment id -> deadline to restore after the RPC rewrites it. */
  let deadlinesToRestore = new Map<number, string>();

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
    // Batched: an `.in()` of more than max_rows ids would come back truncated and
    // report perfectly good submissions as not belonging to the assignment.
    const validSubmissions: Array<{ id: number }> = [];
    for (let i = 0; i < submissionIds.length; i += 500) {
      const batch = submissionIds.slice(i, i + 500);
      const rows = await pageAll<{ id: number }>(
        () =>
          supabase
            .from("submissions")
            .select("id")
            .eq("assignment_id", assignment.id)
            .in("id", batch)
            .order("id", { ascending: true }),
        "Failed to validate submissions"
      );
      validSubmissions.push(...rows);
    }

    const validIds = new Set(validSubmissions.map((s) => s.id));
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

    // Grading conflicts and self-review exclusions apply to explicit manifests
    // too. bulk_assign_reviews does not enforce them, so skipping this check
    // would let `--file` quietly do what the round-robin path refuses to: hand
    // someone their own submission, or a student they are conflicted with.
    const manifestSubmissions: Array<{ id: number; profile_id: string | null; assignment_group_id: number | null }> =
      [];
    for (let i = 0; i < submissionIds.length; i += 500) {
      const batch = submissionIds.slice(i, i + 500);
      const rows = await pageAll<{ id: number; profile_id: string | null; assignment_group_id: number | null }>(
        () =>
          supabase
            .from("submissions")
            .select("id, profile_id, assignment_group_id")
            .eq("assignment_id", assignment.id)
            .in("id", batch)
            .order("id", { ascending: true }),
        "Failed to load submissions"
      );
      manifestSubmissions.push(...rows);
    }

    const excluded = await buildConflictExclusions(supabase, classData.id, manifestSubmissions);
    const violations = drafts
      .filter((d) => excluded.get(d.submission_id)?.has(d.assignee_profile_id))
      .map((d) => `${d.assignee_profile_id} -> submission ${d.submission_id}`);
    if (violations.length > 0) {
      throw new CLICommandError(
        "These assignments conflict with a grading_conflicts entry or would have someone review their own " +
          `submission:\n  ${violations.join("\n  ")}`,
        400
      );
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

    const submissions = await pageAll<{ id: number; profile_id: string | null; assignment_group_id: number | null }>(
      () =>
        supabase
          .from("submissions")
          .select("id, profile_id, assignment_group_id")
          .eq("assignment_id", assignment.id)
          .eq("is_active", true)
          .order("id", { ascending: true }),
      "Failed to load submissions"
    );
    if (submissions.length === 0) {
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

    // Every existing assignment, not a capped slice: a hidden row makes the
    // allocator treat covered work as unassigned, and if it then picks a
    // different assignee, bulk_assign_reviews adds a second assignment for the
    // same work. That is reachable in a large by-part round and would break
    // rerun idempotence.
    const existingRows = await fetchReviewAssignments(supabase, assignment.id, FETCH_ALL, { rubricId });

    // Existing assignments can still point at a submission that has since been
    // superseded by a resubmission. Comparing raw submission ids would treat the
    // student's current active submission as unassigned and draft it again —
    // usually to a different assignee, because the stale assignment still seeds
    // reviewer load. bulk_assign_reviews only retargets rows its own drafts
    // touch, so the stale assignment would survive and the work would be graded
    // twice. Coverage is therefore keyed on the *active* submission for the same
    // student or group.
    const activeSubmissionByOwner = buildActiveSubmissionIndex(submissions);

    /** Maps a possibly-stale submission id onto its owner's active submission. */
    const toActiveSubmissionId = (row: Record<string, unknown>): number => {
      const embedded = row.submissions as { assignment_group_id: number | null; profile_id: string | null } | null;
      const owner = embedded ? { groupId: embedded.assignment_group_id, profileId: embedded.profile_id } : null;
      return activeSubmissionFor(owner, row.submission_id as number, activeSubmissionByOwner);
    };

    const existing: DraftAssignment[] = [];
    // Drafts whose only job is to make the RPC retarget a stale row. Remapping
    // coverage alone was not enough: with nothing to assign, the handler returned
    // without calling the RPC at all, so the grader stayed attached to the
    // obsolete submission while the command reported everything as assigned.
    // bulk_assign_reviews retargets only the review_assignments its own drafts
    // resolve to (Phase 2 filters on the ids it collected), so the draft has to
    // carry the *stale* submission id — which the RPC accepts, since it validates
    // class and assignment membership without requiring is_active.
    const retargetDrafts: DraftAssignment[] = [];
    // The RPC sets due_date = p_due_date on every assignment it *reuses*, and a
    // repair draft reuses the stale row by design. Left alone, a rerun with a new
    // deadline would silently reschedule exactly the stale assignments while
    // leaving every other existing one untouched. Their original deadlines are
    // captured here and restored after the write.
    const staleDueDates = new Map<number, string>();
    for (const row of existingRows) {
      const parts = (row.review_assignment_rubric_parts ?? []) as Array<{ rubric_part_id: number }>;
      const rawSubmissionId = row.submission_id as number;
      const submissionId = toActiveSubmissionId(row);
      const isStale = submissionId !== rawSubmissionId;
      const assignee = row.assignee_profile_id as string;

      const partIds: Array<number | null> = parts.length === 0 ? [null] : parts.map((part) => part.rubric_part_id);
      for (const rubricPartId of partIds) {
        existing.push({ assignee_profile_id: assignee, submission_id: submissionId, rubric_part_id: rubricPartId });
        if (isStale) {
          retargetDrafts.push({
            assignee_profile_id: assignee,
            submission_id: rawSubmissionId,
            rubric_part_id: rubricPartId
          });
          staleDueDates.set(row.id as number, row.due_date as string);
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
    // Retargets first, so a run that has nothing new to assign still repairs
    // assignments left pointing at superseded submissions.
    drafts = [...retargetDrafts, ...allocation.drafts];
    retargetCount = retargetDrafts.length;
    deadlinesToRestore = staleDueDates;
  }

  const response = {
    class: { id: classData.id, slug: classData.slug, name: classData.name },
    assignment: { id: assignment.id, slug: assignment.slug, title: assignment.title },
    rubric_id: rubricId,
    due_date: dueDateIso,
    drafts,
    load: summarizeLoad(drafts),
    skipped_already_assigned: allocation?.skippedAlreadyAssigned ?? 0,
    /** Existing assignments repointed from a superseded submission to the current one. */
    retargeted_stale: retargetCount,
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

  // A fresh client, not ctx.supabase: that one carries a 60-second JWT minted at
  // authentication time with auto-refresh disabled, and the paging above can
  // outlast it on a large course — which would fail an otherwise valid run right
  // at the write. Re-minting reuses the cache when it is still comfortably valid.
  const writeClient = await createAuthenticatedSupabaseClient(ctx.userId);

  const { data: rpcResult, error: rpcError } = await writeClient.rpc("bulk_assign_reviews", {
    p_class_id: classData.id,
    p_assignment_id: assignment.id,
    p_rubric_id: rubricId,
    p_draft_assignments: drafts as unknown as Json,
    p_due_date: dueDateIso
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
      statusForRpcErrorCode(result.error_code)
    );
  }

  // Undo the deadline rewrite the RPC applied to repaired rows. Grouped by value
  // so a large repair is a handful of updates rather than one per row.
  let deadlinesRestored = 0;
  if (deadlinesToRestore.size > 0) {
    const idsByDueDate = new Map<string, number[]>();
    for (const [id, dueDate] of deadlinesToRestore) {
      const ids = idsByDueDate.get(dueDate) ?? [];
      ids.push(id);
      idsByDueDate.set(dueDate, ids);
    }
    for (const [dueDate, ids] of idsByDueDate) {
      for (let i = 0; i < ids.length; i += 500) {
        const { error: restoreError } = await supabase
          .from("review_assignments")
          .update({ due_date: dueDate })
          .in("id", ids.slice(i, i + 500));
        if (restoreError) {
          throw new CLICommandError(
            `Assignments were written, but restoring the original deadline on repaired rows failed: ${restoreError.message}`,
            500
          );
        }
      }
    }
    deadlinesRestored = deadlinesToRestore.size;
  }

  return {
    success: true,
    data: { ...response, dry_run: false, result: rpcResult, deadlines_preserved: deadlinesRestored }
  };
}

/**
 * HTTP status for a `bulk_assign_reviews` failure payload.
 *
 * Every failure comes back through the RPC's `WHEN OTHERS` handler with the
 * SQLSTATE attached, so its deliberate validation errors and a genuine internal
 * fault are indistinguishable without inspecting the code. Treating them all as
 * 400 blamed the caller for the server's problems and — because cli/index.ts
 * only reports 5xx — kept statement timeouts out of Sentry entirely.
 */
function statusForRpcErrorCode(errorCode: string | undefined): number {
  switch (errorCode) {
    // Raised deliberately: assignee or caller lacks the required role.
    case "42501": // insufficient_privilege
      return 403;
    // Raised deliberately: a submission, rubric part, or assignment does not
    // belong where the caller claimed.
    case "23503": // foreign_key_violation
    case "P0001": // raise_exception — the RPC's bare RAISE EXCEPTION validations
      return 400;
    // Anything else is ours: statement timeout (57014), deadlock, a bug.
    default:
      return 500;
  }
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
    // Batched by group *and* paged within each batch: a truncated read here drops
    // a group member, and a dropped member can be handed their own submission.
    const BATCH = 200;
    for (let i = 0; i < groupIds.length; i += BATCH) {
      const batch = groupIds.slice(i, i + BATCH);
      const rows = await pageAll<{ assignment_group_id: number; profile_id: string }>(
        () =>
          supabase
            .from("assignment_groups_members")
            .select("assignment_group_id, profile_id")
            .in("assignment_group_id", batch)
            .order("id", { ascending: true }),
        "Failed to load group members"
      );
      for (const row of rows) {
        const list = groupMembers.get(row.assignment_group_id) ?? [];
        list.push(row.profile_id);
        groupMembers.set(row.assignment_group_id, list);
      }
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

  const conflicts = await pageAll<{ grader_profile_id: string; student_profile_id: string }>(
    () =>
      supabase
        .from("grading_conflicts")
        .select("grader_profile_id, student_profile_id")
        .eq("class_id", classId)
        .order("id", { ascending: true }),
    "Failed to load grading conflicts"
  );

  // student -> graders barred from grading them.
  const conflictsByStudent = new Map<string, string[]>();
  for (const c of conflicts) {
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
