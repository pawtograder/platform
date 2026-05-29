/**
 * Assignment + grade push via AGS.
 *
 * For an assignment we:
 *   1. ensure a line item exists on the platform (creating/updating it), keyed by
 *      a stable resourceId so the operation is idempotent,
 *   2. record the mapping in `lti_line_items`,
 *   3. publish each released student score, mapping Pawtograder profiles to the
 *      student's LTI `sub` via `user_roles` + `lti_users`.
 */
import "server-only";
import { AGS_SCOPE, type AgsScore } from "./types";
import { ensureLineItem, publishScore } from "./ags";
import { ltiAdminClient, type LtiDb } from "./db";

export type GradePushResult = {
  assignmentId: number;
  classId: number;
  lineItemUrl: string;
  pushed: number;
  skipped: number;
  failures: Array<{ studentId: string; reason: string }>;
};

type ContextForGrades = {
  id: number;
  platform_id: number;
  ags_lineitems_url: string;
  ags_scopes: string[] | null;
};

async function getGradeContext(classId: number, db: LtiDb): Promise<ContextForGrades> {
  const { data, error } = await db
    .from("lti_context_links")
    .select("id, platform_id, ags_lineitems_url, ags_scopes")
    .eq("class_id", classId)
    .not("ags_lineitems_url", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.ags_lineitems_url) {
    throw new Error("This class has no LTI context with an AGS line items endpoint");
  }
  return data as ContextForGrades;
}

/** Push a single assignment's grades to the platform gradebook. */
export async function pushAssignmentGrades(
  classId: number,
  assignmentId: number,
  db: LtiDb = ltiAdminClient()
): Promise<GradePushResult> {
  const ctx = await getGradeContext(classId, db);
  if (!(ctx.ags_scopes ?? []).includes(AGS_SCOPE.score)) {
    // Not fatal: some platforms grant scopes lazily. Warn via thrown context only
    // if the push itself fails; proceed optimistically.
  }

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

  const scoreMaximum = column.max_score ?? assignment.total_points ?? 100;
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

  // 2. Record the mapping.
  await db.from("lti_line_items").upsert(
    {
      context_link_id: ctx.id,
      class_id: classId,
      assignment_id: assignment.id,
      gradebook_column_id: assignment.gradebook_column_id,
      line_item_url: lineItemUrl,
      label: assignment.title,
      score_maximum: scoreMaximum,
      last_pushed_at: new Date().toISOString()
    },
    { onConflict: "context_link_id,assignment_id" }
  );

  // 3. Collect released grades.
  const { data: grades, error: gErr } = await db
    .from("gradebook_column_students")
    .select("student_id, score, score_override, released, is_excused")
    .eq("gradebook_column_id", assignment.gradebook_column_id)
    .eq("class_id", classId)
    .eq("is_private", true);
  if (gErr) throw gErr;

  // Map private_profile_id -> user_id -> lti sub.
  const profileIds = (grades ?? []).map((g) => g.student_id);
  const subByProfile = await resolveSubsByProfile(classId, ctx.platform_id, profileIds, db);

  const result: GradePushResult = {
    assignmentId,
    classId,
    lineItemUrl,
    pushed: 0,
    skipped: 0,
    failures: []
  };
  const now = new Date().toISOString();

  for (const g of grades ?? []) {
    const finalScore = g.score_override ?? g.score;
    if (!g.released || finalScore === null || g.is_excused) {
      result.skipped += 1;
      continue;
    }
    const sub = subByProfile.get(g.student_id);
    if (!sub) {
      result.skipped += 1;
      result.failures.push({ studentId: g.student_id, reason: "No LTI identity mapped for student" });
      continue;
    }
    const score: AgsScore = {
      userId: sub,
      scoreGiven: finalScore,
      scoreMaximum,
      timestamp: now,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded"
    };
    try {
      await publishScore(ctx.platform_id, lineItemUrl, score, db);
      result.pushed += 1;
    } catch (e) {
      result.failures.push({ studentId: g.student_id, reason: (e as Error).message });
    }
  }

  return result;
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

  const userIds = [...userIdByProfile.values()];
  if (userIds.length === 0) return out;

  const { data: ltiUsers } = await db
    .from("lti_users")
    .select("user_id, sub")
    .eq("platform_id", platformId)
    .in("user_id", userIds);
  const subByUserId = new Map<string, string>();
  for (const lu of ltiUsers ?? []) if (lu.user_id) subByUserId.set(lu.user_id, lu.sub);

  for (const [profileId, userId] of userIdByProfile.entries()) {
    const sub = subByUserId.get(userId);
    if (sub) out.set(profileId, sub);
  }
  return out;
}
