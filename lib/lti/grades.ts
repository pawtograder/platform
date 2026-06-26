/**
 * Assignment + grade sync via AGS.
 *
 * For an assignment we:
 *   1. ensure a line item exists on the platform (creating/updating it), keyed by
 *      a stable resourceId so the operation is idempotent,
 *   2. record the mapping in `lti_line_items`,
 *   3. reconcile each student's released score against what we last sent
 *      (`lti_grade_sync_state`): publish new/changed scores, retract scores that
 *      are no longer released/graded, and skip ones that are already in sync.
 *
 * The reconcile is incremental and self-correcting: re-running it is cheap (only
 * changed students hit the platform) and it converges the LMS gradebook to the
 * current Pawtograder state, including clearing stale grades.
 */
import "server-only";
import { type AgsScore } from "./types";
import { ensureLineItem, publishScore, retractScore } from "./ags";
import { ltiAdminClient, type LtiDb } from "./db";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type GradeSyncStateInsert = Database["public"]["Tables"]["lti_grade_sync_state"]["Insert"];

export type GradePushResult = {
  assignmentId: number;
  classId: number;
  lineItemUrl: string;
  pushed: number;
  retracted: number;
  skipped: number;
  failures: Array<{ studentId: string; reason: string }>;
};

type ContextForGrades = {
  id: number;
  platform_id: number;
  ags_lineitems_url: string;
  ags_scopes: string[] | null;
  section_role: "lecture" | "lab" | "course_wide";
};

type SyncStateRow = {
  student_profile_id: string;
  lti_user_sub: string | null;
  synced_score: number | null;
  line_item_id: number | null;
  status: "synced" | "retracted" | "failed" | "no_identity";
  attempts: number;
};

/**
 * Pick the context to push grades into. With a single AGS context this is the
 * one (today's behavior). With several (lecture+lab, cross-listed sections), we
 * deterministically prefer the `lecture` context — the canonical gradebook —
 * rather than the old `.limit(1)` which could pick the lab context and post to
 * the wrong Canvas course.
 *
 * TODO(phase2): per-student section→context routing (docs/lti-section-mapping.md
 * §7.3) — route each student's score to the line item of the Canvas course that
 * owns *their* section, instead of a single class-wide context.
 */
async function getGradeContext(classId: number, db: LtiDb): Promise<ContextForGrades> {
  const { data, error } = await db
    .from("lti_context_links")
    .select("id, platform_id, ags_lineitems_url, ags_scopes, section_role")
    .eq("class_id", classId)
    .eq("grade_sync_enabled", true)
    .not("ags_lineitems_url", "is", null)
    .order("id", { ascending: true });
  if (error) throw error;
  const contexts = (data ?? []) as ContextForGrades[];
  if (contexts.length === 0) {
    throw new Error("This class has no LTI context with grade sync enabled and an AGS line items endpoint");
  }
  return contexts.find((c) => c.section_role === "lecture") ?? contexts[0];
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

/**
 * Reconcile a single assignment's grades to the platform gradebook. Publishes
 * released scores, retracts grades that are no longer released/graded, and skips
 * ones already in sync. Records the per-student outcome in `lti_grade_sync_state`.
 */
export async function syncAssignmentGrades(
  classId: number,
  assignmentId: number,
  db: LtiDb = ltiAdminClient()
): Promise<GradePushResult> {
  const ctx = await getGradeContext(classId, db);

  // Assignment + its gradebook column.
  const { data: assignment, error: aErr } = await db
    .from("assignments")
    .select("id, class_id, title, slug, total_points, gradebook_column_id")
    .eq("id", assignmentId)
    .eq("class_id", classId)
    .single();
  if (aErr) throw aErr;
  if (!assignment.gradebook_column_id) {
    throw new Error(`Assignment ${assignmentId} has no gradebook column to push`);
  }

  const { data: column, error: cErr } = await db
    .from("gradebook_columns")
    .select("id, max_score")
    .eq("id", assignment.gradebook_column_id)
    .single();
  if (cErr) throw cErr;

  // Use `||` (not `??`) so a 0-point column/assignment falls back to a positive
  // maximum: Canvas computes scoreGiven*(points_possible/scoreMaximum) and
  // rejects the whole push on a scoreMaximum of 0 (division by zero).
  const scoreMaximum = column.max_score || assignment.total_points || 100;
  const resourceId = `pawtograder_assignment_${assignment.id}`;

  // 1. Ensure the line item exists.
  const { id: lineItemUrl } = await ensureLineItem(
    ctx.platform_id,
    ctx.ags_lineitems_url,
    {
      scoreMaximum,
      label: assignment.title,
      resourceId,
      tag: assignment.slug ?? undefined
    },
    db
  );

  // 2. Record the mapping. NB: last_pushed_at is set at the END (after the run),
  // so it reflects an actual reconcile rather than just an attempt.
  //
  // Read the PRIOR score_maximum first (the upsert below overwrites it): when the
  // column max changes, a student's scoreGiven is re-scaled by the platform, so
  // unchanged scores must be re-published rather than skipped (see the skip below).
  const { data: priorLineItem } = await db
    .from("lti_line_items")
    .select("score_maximum")
    .eq("context_link_id", ctx.id)
    .eq("assignment_id", assignment.id)
    .maybeSingle();
  const prevMax = priorLineItem?.score_maximum ?? null;
  const maxChanged = prevMax !== null && prevMax !== scoreMaximum;

  // Upsert via RPC so the (context_link_id, assignment_id) and
  // (context_link_id, gradebook_column_id) unique constraints are resolved
  // atomically — a PostgREST upsert can only declare one arbiter and would abort
  // the push if a gradebook column was reassigned between assignments.
  const { data: lineItemId, error: liErr } = await db.rpc("lti_upsert_line_item", {
    p_context_link_id: ctx.id,
    p_class_id: classId,
    p_assignment_id: assignment.id,
    p_gradebook_column_id: assignment.gradebook_column_id,
    p_line_item_url: lineItemUrl,
    p_label: assignment.title,
    p_score_maximum: scoreMaximum
  });
  if (liErr) throw liErr;
  if (lineItemId == null) throw new Error("lti_upsert_line_item returned no id");

  // 3. Load ALL grades for the column (not just released) so we can also detect
  // ones that must be retracted, plus the prior sync state for diffing.
  const { data: grades, error: gErr } = await db
    .from("gradebook_column_students")
    .select("student_id, score, score_override, released, is_excused")
    .eq("gradebook_column_id", assignment.gradebook_column_id)
    .eq("class_id", classId)
    .eq("is_private", true);
  if (gErr) throw gErr;
  const rows = grades ?? [];

  const { data: stateData } = await db
    .from("lti_grade_sync_state")
    .select("student_profile_id, lti_user_sub, synced_score, line_item_id, status, attempts")
    .eq("assignment_id", assignment.id);
  const prevByProfile = new Map<string, SyncStateRow>();
  for (const s of (stateData ?? []) as SyncStateRow[]) prevByProfile.set(s.student_profile_id, s);

  // Map private_profile_id -> lti sub (via user_roles, with an email fallback so
  // roster-synced students who never launched the tool still resolve).
  const profileIds = rows.map((g) => g.student_id);
  const subByProfile = await resolveSubsByProfile(classId, ctx.platform_id, profileIds, db);

  const result: GradePushResult = {
    assignmentId,
    classId,
    lineItemUrl,
    pushed: 0,
    retracted: 0,
    skipped: 0,
    failures: []
  };
  const now = new Date().toISOString();
  const stateRows: GradeSyncStateInsert[] = [];

  await runPool(rows, 8, async (g) => {
    const finalScore = g.score_override ?? g.score;
    const shouldHaveScore = g.released && !g.is_excused && finalScore !== null;
    const sub = subByProfile.get(g.student_id);
    const prev = prevByProfile.get(g.student_id);
    const baseAttempts = prev?.attempts ?? 0;

    // Keep keys uniform across every row: a bulk upsert with mismatched object
    // keys is rejected by PostgREST ("All object keys must match").
    const pushState = (extra: {
      lti_user_sub: string | null;
      synced_score: number | null;
      status: "synced" | "retracted" | "failed" | "no_identity";
      error: string | null;
      attempts: number;
      synced_at?: string | null;
    }) =>
      stateRows.push({
        class_id: classId,
        assignment_id: assignment.id,
        line_item_id: lineItemId,
        student_profile_id: g.student_id,
        last_attempt_at: now,
        synced_at: null,
        ...extra
      });

    if (shouldHaveScore) {
      if (!sub) {
        result.skipped += 1;
        result.failures.push({ studentId: g.student_id, reason: "No LTI identity mapped for student" });
        pushState({
          lti_user_sub: null,
          synced_score: null,
          status: "no_identity",
          error: "No LTI identity mapped for student",
          attempts: baseAttempts + 1
        });
        return;
      }
      // Already in sync? Skip the network round-trip. We must also be synced to
      // the SAME line item (prev.line_item_id === lineItemId): if the selected
      // grade-sync context changed, the student is synced to a different line
      // item and must be re-published to the current one. And if the column max
      // changed (maxChanged), re-publish so the platform re-scales.
      if (
        prev?.status === "synced" &&
        prev.synced_score === finalScore &&
        prev.lti_user_sub === sub &&
        prev.line_item_id === lineItemId &&
        !maxChanged
      ) {
        result.skipped += 1;
        return;
      }
      const score: AgsScore = {
        userId: sub,
        scoreGiven: finalScore as number,
        scoreMaximum,
        timestamp: now,
        activityProgress: "Completed",
        gradingProgress: "FullyGraded"
      };
      try {
        await publishScore(ctx.platform_id, lineItemUrl, score, db);
        result.pushed += 1;
        pushState({
          lti_user_sub: sub,
          synced_score: finalScore,
          status: "synced",
          error: null,
          attempts: baseAttempts + 1,
          synced_at: now
        });
      } catch (e) {
        result.failures.push({ studentId: g.student_id, reason: (e as Error).message });
        pushState({
          lti_user_sub: sub,
          synced_score: prev?.synced_score ?? null,
          status: "failed",
          error: (e as Error).message,
          attempts: baseAttempts + 1
        });
      }
      return;
    }

    // Should NOT have a score. Retract only if we previously published one.
    if (prev?.status === "synced" && prev.synced_score !== null) {
      const retractSub = sub ?? prev.lti_user_sub;
      if (!retractSub) {
        result.skipped += 1;
        return;
      }
      try {
        await retractScore(ctx.platform_id, lineItemUrl, retractSub, db);
        result.retracted += 1;
        pushState({
          lti_user_sub: retractSub,
          synced_score: null,
          status: "retracted",
          error: null,
          attempts: baseAttempts + 1,
          synced_at: now
        });
      } catch (e) {
        result.failures.push({ studentId: g.student_id, reason: `retract failed: ${(e as Error).message}` });
        pushState({
          lti_user_sub: retractSub,
          synced_score: prev.synced_score,
          status: "failed",
          error: (e as Error).message,
          attempts: baseAttempts + 1
        });
      }
      return;
    }

    // Nothing to do (never synced and not releasable).
    result.skipped += 1;
  });

  if (stateRows.length > 0) {
    await db.from("lti_grade_sync_state").upsert(stateRows, { onConflict: "assignment_id,student_profile_id" });
  }

  await db.from("lti_line_items").update({ last_pushed_at: new Date().toISOString() }).eq("id", lineItemId);

  return result;
}

/** Back-compat alias for the previous name. */
export const pushAssignmentGrades = syncAssignmentGrades;

export type DrainItemResult = {
  classId: number;
  assignmentId: number;
  ok: boolean;
  result?: GradePushResult;
  error?: string;
};

/**
 * Process the on-release work queue: reconcile each enqueued assignment, then
 * remove its queue row. The row is removed whether the reconcile succeeds or
 * throws, so a persistent error (e.g. grade sync disabled) can't make the
 * safety-net cron re-kick forever — durable per-student failures live in
 * `lti_grade_sync_state` and the trigger re-enqueues on the next grade change.
 */
export async function drainGradeSyncQueue(db: LtiDb = ltiAdminClient(), limit = 100): Promise<DrainItemResult[]> {
  const { data: queue } = await db
    .from("lti_grade_sync_queue")
    .select("class_id, assignment_id, enqueued_at")
    .order("enqueued_at", { ascending: true })
    .limit(limit);

  const out: DrainItemResult[] = [];
  for (const item of queue ?? []) {
    try {
      const result = await syncAssignmentGrades(item.class_id, item.assignment_id, db);
      out.push({ classId: item.class_id, assignmentId: item.assignment_id, ok: true, result });
    } catch (e) {
      out.push({ classId: item.class_id, assignmentId: item.assignment_id, ok: false, error: (e as Error).message });
    } finally {
      // Delete only if the row hasn't been re-enqueued since we read it. The
      // enqueue trigger bumps enqueued_at (ON CONFLICT DO UPDATE), so a grade
      // change that landed WHILE this assignment was syncing leaves a newer
      // enqueued_at; matching on it means that delete affects 0 rows, the row
      // survives, and the next drain (or safety-net cron) reprocesses it. Without
      // this guard the re-enqueued work would be silently dropped.
      await db
        .from("lti_grade_sync_queue")
        .delete()
        .eq("class_id", item.class_id)
        .eq("assignment_id", item.assignment_id)
        .eq("enqueued_at", item.enqueued_at);
    }
  }
  return out;
}

async function resolveSubsByProfile(
  classId: number,
  platformId: number,
  profileIds: string[],
  db: LtiDb
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (profileIds.length === 0) return out;

  const { data: roles } = await db
    .from("user_roles")
    .select("user_id, private_profile_id")
    .eq("class_id", classId)
    .in("private_profile_id", profileIds);
  const userIdByProfile = new Map<string, string>();
  for (const r of roles ?? []) {
    if (r.private_profile_id && r.user_id) userIdByProfile.set(r.private_profile_id, r.user_id);
  }

  const userIds = [...new Set(userIdByProfile.values())];
  if (userIds.length === 0) return out;

  // Email of each user, for the fallback path.
  const { data: users } = await db.from("users").select("user_id, email").in("user_id", userIds);
  const emailByUserId = new Map<string, string>();
  const emailForms = new Set<string>();
  for (const u of users ?? []) {
    if (u.user_id && u.email) {
      emailByUserId.set(u.user_id, u.email.toLowerCase());
      emailForms.add(u.email);
      emailForms.add(u.email.toLowerCase());
    }
  }

  // Resolve sub by user_id (launched students) and by email (roster-synced but
  // never-launched students, whose lti_users row may have a null user_id).
  const subByUserId = new Map<string, string>();
  const subByEmailLower = new Map<string, string>();
  const { data: byUser } = await db
    .from("lti_users")
    .select("user_id, sub, email")
    .eq("platform_id", platformId)
    .in("user_id", userIds);
  for (const lu of byUser ?? []) {
    if (lu.user_id) subByUserId.set(lu.user_id, lu.sub);
    if (lu.email) subByEmailLower.set(lu.email.toLowerCase(), lu.sub);
  }
  if (emailForms.size > 0) {
    const { data: byEmail } = await db
      .from("lti_users")
      .select("sub, email")
      .eq("platform_id", platformId)
      .in("email", [...emailForms]);
    for (const lu of byEmail ?? []) if (lu.email) subByEmailLower.set(lu.email.toLowerCase(), lu.sub);
  }

  for (const [profileId, userId] of userIdByProfile.entries()) {
    const email = emailByUserId.get(userId);
    const sub = subByUserId.get(userId) ?? (email ? subByEmailLower.get(email) : undefined);
    if (sub) out.set(profileId, sub);
  }
  return out;
}
