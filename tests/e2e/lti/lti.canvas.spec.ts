/**
 * End-to-end LTI 1.3 verification against a real Canvas LMS.
 *
 * Exercises the full integration in both directions:
 *   1. Resource-link LAUNCH from Canvas -> Pawtograder SSO session (OIDC).
 *   2. NRPS roster sync: pull the Canvas roster into the linked Pawtograder class.
 *   3. AGS grade passback: push a Pawtograder grade back to the Canvas gradebook.
 *
 * Visual screenshots (Argos, like the rest of the suite) are captured at each
 * milestone via visualScreenshot().
 *
 * Prereqs are stood up by tests/e2e/canvas/run-e2e.sh (Canvas + tool + Supabase
 * seeded; config written to tests/e2e/lti/.canvas-e2e.json). This spec runs
 * only under playwright.canvas.config.ts.
 */
import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { createAdminClient } from "@/utils/supabase/client";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { createClass, createAssignmentsAndGradebookColumns, createUserInClass } from "../TestingUtils";
import { visualScreenshot } from "../VisualTestUtils";

type CanvasConfig = {
  canvasBaseUrl: string;
  toolBaseUrl: string;
  issuer: string;
  clientId: string;
  deploymentId: string;
  canvasCourseId: string;
  canvasToolId: string;
  canvasAssignmentId: string;
  teacher: { email: string; password: string };
  /** A Canvas TA (TeachingAssistant) — for asserting LTI role mapping → grader. */
  ta?: { email: string; password: string };
  students: { email: string; password: string }[];
  /** Distinct Canvas course section names the seed created. */
  sectionNames?: string[];
  /** Map of student email -> the Canvas section name they were enrolled in. */
  studentSections?: Record<string, string>;
  canvasAdminToken: string;
  ltiCronSecret?: string;
};

const CONFIG_PATH = path.join(__dirname, ".canvas-e2e.json");
const cfg: CanvasConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const supabase = createAdminClient<Database>();
// Prefer the secret captured in the config by run-e2e.sh (exactly what the tool
// was started with) over ambient env, which can drift.
const cronSecret = cfg.ltiCronSecret ?? process.env.LTI_CRON_SHARED_SECRET ?? "";

// Shared across the serial steps.
let pawClassId: number;
let pawAssignmentId: number;
let pawAssignmentTitle: string;
let gradebookColumnId: number;
// A second assignment/column, used to exercise grade gating (unreleased/null)
// independently of the first assignment's pushed grade.
let pawAssignment2Id: number;
let gradebookColumn2Id: number;
let platformId: number;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // Pawtograder-side state: a class + one assignment with a gradebook column.
  const klass = await createClass({ name: "LTI Canvas E2E" });
  pawClassId = klass.id;
  // numAssignments >= 2: the helper spaces due dates as diff/(n-1).
  const { assignments } = await createAssignmentsAndGradebookColumns({
    class_id: pawClassId,
    numAssignments: 2,
    numManualGradedColumns: 0
  });
  pawAssignmentId = assignments[0].id as number;
  pawAssignmentTitle = assignments[0].title as string;
  gradebookColumnId = assignments[0].gradebook_column_id as number;
  pawAssignment2Id = assignments[1].id as number;
  gradebookColumn2Id = assignments[1].gradebook_column_id as number;

  const { data: platform } = await supabase
    .from("lti_platforms")
    .select("id")
    .eq("issuer", cfg.issuer)
    .eq("client_id", cfg.clientId)
    .single();
  platformId = platform!.id;
});

async function canvasLogin(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto(`${cfg.canvasBaseUrl}/login/canvas`, { waitUntil: "domcontentloaded" });
  await page.fill("#pseudonym_session_unique_id", email);
  await page.fill("#pseudonym_session_password", password);
  await page.click('button[type="submit"], input[type="submit"]');
  await page.waitForLoadState("domcontentloaded");
}

async function launchTool(page: import("@playwright/test").Page) {
  // The course external-tool endpoint initiates the LTI 1.3 OIDC launch.
  await page.goto(`${cfg.canvasBaseUrl}/courses/${cfg.canvasCourseId}/external_tools/${cfg.canvasToolId}`, {
    waitUntil: "domcontentloaded"
  });
  // The tool renders inside a Canvas iframe; wait for our launch round-trip to
  // settle (login -> authorize -> form_post -> session).
  await page.waitForTimeout(5000);
}

test("instructor launches Pawtograder from Canvas (OIDC) and gets a session", async ({ page }) => {
  await canvasLogin(page, cfg.teacher.email, cfg.teacher.password);
  await launchTool(page);

  // The launch established a Pawtograder session in this browser. Visit the tool
  // directly to confirm we are signed in (not bounced to the login page).
  await page.goto(`${cfg.toolBaseUrl}/`, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/sign-in/);
  await visualScreenshot(page, "lti-01-launch-landing");

  // The launch must have recorded the context with NRPS + AGS endpoints.
  const { data: link } = await supabase
    .from("lti_context_links")
    .select("id, nrps_url, ags_lineitems_url")
    .eq("platform_id", platformId)
    .eq("deployment_id", cfg.deploymentId)
    .single();
  expect(link?.nrps_url).toBeTruthy();
  expect(link?.ags_lineitems_url).toBeTruthy();

  // Link the LMS context to our Pawtograder class and enable sync (the admin
  // "link" action; no UI for it yet).
  await supabase
    .from("lti_context_links")
    .update({ class_id: pawClassId, roster_sync_enabled: true, grade_sync_enabled: true })
    .eq("id", link!.id);
});

test("NRPS roster sync enrolls the Canvas roster into the class", async ({ page, request }) => {
  // First sync runs via the cron path (no instructor exists in the class yet).
  const res = await request.post(`${cfg.toolBaseUrl}/api/lti/sync-roster`, {
    headers: { "x-lti-cron-secret": cronSecret },
    data: { all: true }
  });
  const syncBody = await res.text();
  expect(res.ok(), `sync-roster ${res.status()}: ${syncBody}`).toBeTruthy();
  // Surface per-context sync errors (NRPS fetch / token) instead of silently
  // passing the HTTP check while syncing 0 members.
  const syncJson = JSON.parse(syncBody) as { results?: { status: string; message: string }[] };
  for (const r of syncJson.results ?? []) expect(r.status, r.message).toBe("success");

  // Teacher (an LTI Instructor) is adopted as an instructor enrollment.
  const { data: roles } = await supabase.from("user_roles").select("role, users(email)").eq("class_id", pawClassId);
  const enrolledEmails = (roles ?? []).map((r) => (r.users as { email: string } | null)?.email).filter(Boolean);
  const instructorEmails = (roles ?? [])
    .filter((r) => r.role === "instructor")
    .map((r) => (r.users as { email: string } | null)?.email);
  expect(instructorEmails).toContain(cfg.teacher.email);

  // Each Canvas student is represented in the class — either already enrolled
  // (had a Pawtograder account, matched by email) or invited with their email.
  const { data: invites } = await supabase.from("invitations").select("email, role").eq("class_id", pawClassId);
  const inviteEmails = (invites ?? []).map((i) => i.email);
  const rosterEmails = new Set([...enrolledEmails, ...inviteEmails]);
  for (const s of cfg.students) expect([...rosterEmails]).toContain(s.email);

  // Role mapping: a Canvas TA (TeachingAssistant) becomes a Pawtograder grader.
  if (cfg.ta) {
    const taEnrollRole = (roles ?? []).find(
      (r) => (r.users as { email: string } | null)?.email === cfg.ta!.email
    )?.role;
    const taInviteRole = (invites ?? []).find((i) => i.email === cfg.ta!.email)?.role;
    expect(taEnrollRole ?? taInviteRole, `TA ${cfg.ta.email} should map to grader`).toBe("grader");
  }

  // Idempotency: a second sync of the same roster must not create duplicate
  // enrollments or invitations.
  const beforeRoles = (roles ?? []).length;
  const beforeInvites = (invites ?? []).length;
  const res2 = await request.post(`${cfg.toolBaseUrl}/api/lti/sync-roster`, {
    headers: { "x-lti-cron-secret": cronSecret },
    data: { all: true }
  });
  expect(res2.ok(), `re-sync ${res2.status()}`).toBeTruthy();
  const { count: afterRoles } = await supabase
    .from("user_roles")
    .select("id", { count: "exact", head: true })
    .eq("class_id", pawClassId);
  const { count: afterInvites } = await supabase
    .from("invitations")
    .select("id", { count: "exact", head: true })
    .eq("class_id", pawClassId);
  expect(afterRoles, "re-sync should not add user_roles").toBe(beforeRoles);
  expect(afterInvites, "re-sync should not add invitations").toBe(beforeInvites);

  // Show the synced roster in the management UI (teacher session from step 1).
  await page.goto(`${cfg.toolBaseUrl}/course/${pawClassId}/manage/course/lti`, { waitUntil: "domcontentloaded" });
  await visualScreenshot(page, "lti-02-roster-synced");
});

test("student launch is adopted, then a grade is pushed to Canvas (AGS)", async ({ browser, page, request }) => {
  // Launch + re-sync + wait-for-gradebook-row + push + async-score poll is a lot;
  // give this step a generous budget (the score poll alone can take ~2 min in CI).
  test.setTimeout(300_000);
  const student = cfg.students[0];

  // Student launches from Canvas -> creates their Pawtograder account.
  const studentCtx = await browser.newContext();
  const studentPage = await studentCtx.newPage();
  await canvasLogin(studentPage, student.email, student.password);
  await launchTool(studentPage);
  await studentCtx.close();

  // Re-sync so the now-existing student account is adopted as a student
  // enrollment (matched by email), giving them a gradebook row.
  await request.post(`${cfg.toolBaseUrl}/api/lti/sync-roster`, {
    headers: { "x-lti-cron-secret": cronSecret },
    data: { all: true }
  });

  // Resolve the student's private profile in this class and set a released grade.
  const { data: sUser } = await supabase.from("users").select("user_id").eq("email", student.email).single();
  const { data: sRole } = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("class_id", pawClassId)
    .eq("user_id", sUser!.user_id)
    .single();
  expect(sRole?.private_profile_id).toBeTruthy();

  // Enrolling the student creates their gradebook_column_students row via a
  // trigger, which isn't necessarily there the instant the sync RPC returns.
  // Wait for it, then set the released grade (updating by id, so we can assert
  // the row actually existed rather than silently no-op'ing).
  let gradeRowId: number | undefined;
  for (let i = 0; i < 30 && !gradeRowId; i++) {
    const { data: row } = await supabase
      .from("gradebook_column_students")
      .select("id")
      .eq("gradebook_column_id", gradebookColumnId)
      .eq("student_id", sRole!.private_profile_id)
      .eq("is_private", true)
      .maybeSingle();
    gradeRowId = row?.id;
    if (!gradeRowId) await page.waitForTimeout(2000);
  }
  expect(gradeRowId, "student gradebook row should exist after enrollment").toBeTruthy();

  // Use score_override (not score): the assignment column's `score` is derived
  // from submissions and gets reset to null by the gradebook recalc trigger
  // (active via the jobs worker), whereas score_override is a manual value that
  // survives recalc — and pushAssignmentGrades reads `score_override ?? score`.
  const { error: gradeErr } = await supabase
    .from("gradebook_column_students")
    .update({ score_override: 88, released: true })
    .eq("id", gradeRowId!);
  expect(gradeErr).toBeNull();

  // Push grades to Canvas via AGS.
  const pushRes = await request.post(`${cfg.toolBaseUrl}/api/lti/push-grades`, {
    headers: { "x-lti-cron-secret": cronSecret },
    data: { class_id: pawClassId, assignment_id: pawAssignmentId }
  });
  const pushBody = await pushRes.json();
  expect(pushRes.ok(), JSON.stringify(pushBody)).toBeTruthy();
  expect(pushBody.pushed, `push result: ${JSON.stringify(pushBody)}`).toBeGreaterThanOrEqual(1);

  // Verify in Canvas via the regular API. The AGS line item shows up as a course
  // assignment named after the Pawtograder assignment; Canvas processes the
  // score asynchronously (jobs worker), so poll for the submission score.
  const auth = { Authorization: `Bearer ${cfg.canvasAdminToken}` };
  const aRes = await request.get(
    `${cfg.canvasBaseUrl}/api/v1/courses/${cfg.canvasCourseId}/assignments?search_term=${encodeURIComponent(pawAssignmentTitle)}&per_page=100`,
    { headers: auth }
  );
  const canvasAssignments = (await aRes.json()) as Array<{ id: number; name: string }>;
  const canvasAssignment = canvasAssignments.find((a) => a.name === pawAssignmentTitle) ?? canvasAssignments[0];
  expect(canvasAssignment, "AGS line item should appear as a Canvas assignment").toBeTruthy();

  // Canvas processes the AGS score asynchronously (delayed_jobs worker), which is
  // noticeably slower on a CI runner than locally — poll up to ~2 min.
  let landed = false;
  for (let i = 0; i < 40 && !landed; i++) {
    const subRes = await request.get(
      `${cfg.canvasBaseUrl}/api/v1/courses/${cfg.canvasCourseId}/assignments/${canvasAssignment.id}/submissions?per_page=100`,
      { headers: auth }
    );
    const subs = (await subRes.json()) as Array<{ score: number | null }>;
    landed = subs.some((s) => Number(s.score) === 88);
    if (!landed) await page.waitForTimeout(3000);
  }
  expect(landed, "a Canvas submission should carry the pushed score (88)").toBeTruthy();

  // Visual: the Canvas gradebook showing the pushed column/grade (teacher view).
  await canvasLogin(page, cfg.teacher.email, cfg.teacher.password);
  await page.goto(`${cfg.canvasBaseUrl}/courses/${cfg.canvasCourseId}/gradebook`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await visualScreenshot(page, "lti-03-canvas-gradebook");
});

test("a returning student's re-launch reuses the same account (stable identity binding, no duplicate/takeover)", async ({
  browser
}) => {
  // Guards the launch→session bridge (lib/lti/session.ts): a returning user must
  // resolve via the (platform_id, sub) identity binding and sign back into their
  // EXISTING account — never a fresh/duplicate account, and never an email-match
  // takeover of a different one. (The email-adoption gate itself is unit-tested in
  // tests/unit/lti-session.test.ts; the cross-class deep-link guard is covered by
  // resolveLaunchRedirect there — the Canvas seed can't inject custom.assignment_id.)
  test.setTimeout(120_000);
  const student = cfg.students[0];

  // The student already launched + was adopted in the previous step.
  const { data: sUser } = await supabase.from("users").select("user_id").eq("email", student.email).single();
  expect(sUser?.user_id).toBeTruthy();
  const { data: bindingBefore } = await supabase
    .from("lti_users")
    .select("sub, user_id")
    .eq("platform_id", platformId)
    .eq("user_id", sUser!.user_id)
    .single();
  expect(bindingBefore?.user_id).toBe(sUser!.user_id);

  // Launch again from Canvas in a fresh browser context.
  const ctx = await browser.newContext();
  const studentPage = await ctx.newPage();
  await canvasLogin(studentPage, student.email, student.password);
  await launchTool(studentPage);
  await ctx.close();

  // The (platform_id, sub) binding still resolves to the SAME user.
  const { data: bindingAfter } = await supabase
    .from("lti_users")
    .select("user_id")
    .eq("platform_id", platformId)
    .eq("sub", bindingBefore!.sub)
    .single();
  expect(bindingAfter?.user_id).toBe(sUser!.user_id);

  // Exactly one Pawtograder account carries this email (no duplicate provisioned).
  const { count } = await supabase
    .from("users")
    .select("user_id", { count: "exact", head: true })
    .eq("email", student.email);
  expect(count).toBe(1);
});

test("AGS: grade update lands in Canvas; unreleased and null grades are not pushed", async ({ page, request }) => {
  test.setTimeout(240_000);
  const student = cfg.students[0];
  const auth = { Authorization: `Bearer ${cfg.canvasAdminToken}` };

  // The launched student (enrolled in the previous step) and their private profile.
  const { data: sUser } = await supabase.from("users").select("user_id").eq("email", student.email).single();
  const { data: sRole } = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("class_id", pawClassId)
    .eq("user_id", sUser!.user_id)
    .single();
  const studentId = sRole!.private_profile_id as string;

  // Set a grade on a column for this student (by row id), waiting for the
  // enrollment-created gradebook row to exist.
  const setGrade = async (columnId: number, patch: Record<string, unknown>) => {
    let rowId: number | undefined;
    for (let i = 0; i < 15 && !rowId; i++) {
      const { data: row } = await supabase
        .from("gradebook_column_students")
        .select("id")
        .eq("gradebook_column_id", columnId)
        .eq("student_id", studentId)
        .eq("is_private", true)
        .maybeSingle();
      rowId = row?.id;
      if (!rowId) await page.waitForTimeout(2000);
    }
    expect(rowId, `gradebook row for column ${columnId}`).toBeTruthy();
    const { error } = await supabase.from("gradebook_column_students").update(patch).eq("id", rowId!);
    expect(error).toBeNull();
  };

  const pushGrades = async (assignmentId: number) => {
    const res = await request.post(`${cfg.toolBaseUrl}/api/lti/push-grades`, {
      headers: { "x-lti-cron-secret": cronSecret },
      data: { class_id: pawClassId, assignment_id: assignmentId }
    });
    const body = await res.json();
    expect(res.ok(), `push-grades ${res.status()}: ${JSON.stringify(body)}`).toBeTruthy();
    return body as { pushed: number };
  };

  // This student's Canvas submission score for an assignment (by title).
  const canvasScore = async (title: string): Promise<number | null | undefined> => {
    const aRes = await request.get(
      `${cfg.canvasBaseUrl}/api/v1/courses/${cfg.canvasCourseId}/assignments?search_term=${encodeURIComponent(title)}&per_page=100`,
      { headers: auth }
    );
    const a = ((await aRes.json()) as Array<{ id: number; name: string }>).find((x) => x.name === title);
    if (!a) return undefined;
    const subRes = await request.get(
      `${cfg.canvasBaseUrl}/api/v1/courses/${cfg.canvasCourseId}/assignments/${a.id}/submissions?per_page=100`,
      { headers: auth }
    );
    const subs = (await subRes.json()) as Array<{ score: number | null }>;
    return subs.map((s) => s.score).find((s) => s !== null) ?? null;
  };

  // (1) UPDATE: change the released score (88 from the previous step) to 73 and
  // confirm Canvas reflects the new value.
  await setGrade(gradebookColumnId, { score_override: 73, released: true });
  const up = await pushGrades(pawAssignmentId);
  expect(up.pushed, "the released grade should push").toBeGreaterThanOrEqual(1);
  let updated = false;
  for (let i = 0; i < 40 && !updated; i++) {
    updated = Number(await canvasScore(pawAssignmentTitle)) === 73;
    if (!updated) await page.waitForTimeout(3000);
  }
  expect(updated, "Canvas submission score should update to 73").toBeTruthy();

  // (2) RELEASE-GATING: an unreleased grade (on the second column) must not push.
  await setGrade(gradebookColumn2Id, { score_override: 95, released: false });
  const gated = await pushGrades(pawAssignment2Id);
  expect(gated.pushed, `unreleased grade must not push: ${JSON.stringify(gated)}`).toBe(0);

  // (3) NULL: a released but empty grade must not push either.
  await setGrade(gradebookColumn2Id, { score_override: null, score: null, released: true });
  const empty = await pushGrades(pawAssignment2Id);
  expect(empty.pushed, `null grade must not push: ${JSON.stringify(empty)}`).toBe(0);
});

test("AGS: releasing a grade enqueues it; drain syncs it; unreleasing retracts it in Canvas", async ({
  page,
  request
}) => {
  test.setTimeout(240_000);
  const student = cfg.students[0];
  const auth = { Authorization: `Bearer ${cfg.canvasAdminToken}` };

  const { data: sUser } = await supabase.from("users").select("user_id").eq("email", student.email).single();
  const { data: sRole } = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("class_id", pawClassId)
    .eq("user_id", sUser!.user_id)
    .single();
  const studentId = sRole!.private_profile_id as string;

  const gradeRowId = async (columnId: number): Promise<number> => {
    const { data: row } = await supabase
      .from("gradebook_column_students")
      .select("id")
      .eq("gradebook_column_id", columnId)
      .eq("student_id", studentId)
      .eq("is_private", true)
      .maybeSingle();
    expect(row?.id, `gradebook row for column ${columnId}`).toBeTruthy();
    return row!.id;
  };

  const canvasScore = async (title: string): Promise<number | null | undefined> => {
    const aRes = await request.get(
      `${cfg.canvasBaseUrl}/api/v1/courses/${cfg.canvasCourseId}/assignments?search_term=${encodeURIComponent(title)}&per_page=100`,
      { headers: auth }
    );
    const a = ((await aRes.json()) as Array<{ id: number; name: string }>).find((x) => x.name === title);
    if (!a) return undefined;
    const subRes = await request.get(
      `${cfg.canvasBaseUrl}/api/v1/courses/${cfg.canvasCourseId}/assignments/${a.id}/submissions?per_page=100`,
      { headers: auth }
    );
    const subs = (await subRes.json()) as Array<{ score: number | null }>;
    return subs.map((s) => s.score).find((s) => s !== null) ?? null;
  };

  const drain = async () => {
    const res = await request.post(`${cfg.toolBaseUrl}/api/lti/push-grades`, {
      headers: { "x-lti-cron-secret": cronSecret },
      data: { drain: true }
    });
    const body = await res.json();
    expect(res.ok(), `drain ${res.status()}: ${JSON.stringify(body)}`).toBeTruthy();
    return body;
  };

  const id1 = await gradeRowId(gradebookColumnId);

  // (1) ENQUEUE: the on-release DB trigger should enqueue the assignment when a
  // private grade row is released (the HTTP drain-kick may no-op locally if
  // app_url/pg_net are unset, but the enqueue itself runs in-txn regardless).
  await supabase.from("lti_grade_sync_queue").delete().eq("class_id", pawClassId);
  const { error: relErr } = await supabase
    .from("gradebook_column_students")
    .update({ score_override: 81, released: true })
    .eq("id", id1);
  expect(relErr).toBeNull();
  let queued = false;
  for (let i = 0; i < 10 && !queued; i++) {
    const { data } = await supabase
      .from("lti_grade_sync_queue")
      .select("assignment_id")
      .eq("class_id", pawClassId)
      .eq("assignment_id", pawAssignmentId);
    queued = (data ?? []).length > 0;
    if (!queued) await page.waitForTimeout(500);
  }
  expect(queued, "releasing a grade should enqueue the assignment").toBeTruthy();

  // (2) DRAIN: process the queue. Canvas reflects 81, the queue row is removed,
  // and per-student state records the synced value.
  await drain();
  let landed = false;
  for (let i = 0; i < 40 && !landed; i++) {
    landed = Number(await canvasScore(pawAssignmentTitle)) === 81;
    if (!landed) await page.waitForTimeout(3000);
  }
  expect(landed, "drain should push the released score (81) to Canvas").toBeTruthy();
  const { data: qAfter } = await supabase
    .from("lti_grade_sync_queue")
    .select("assignment_id")
    .eq("class_id", pawClassId)
    .eq("assignment_id", pawAssignmentId);
  expect((qAfter ?? []).length, "queue row removed after a successful drain").toBe(0);
  const { data: st1 } = await supabase
    .from("lti_grade_sync_state")
    .select("status, synced_score")
    .eq("assignment_id", pawAssignmentId)
    .eq("student_profile_id", studentId)
    .maybeSingle();
  expect(st1?.status, "state should be synced after drain").toBe("synced");
  expect(Number(st1?.synced_score)).toBe(81);

  // (3) RETRACT: unreleasing a previously-synced grade should clear it in Canvas
  // and record a 'retracted' state, rather than leaving the stale value behind.
  const { error: unrelErr } = await supabase
    .from("gradebook_column_students")
    .update({ released: false })
    .eq("id", id1);
  expect(unrelErr).toBeNull();
  await drain();
  let cleared = false;
  for (let i = 0; i < 40 && !cleared; i++) {
    cleared = (await canvasScore(pawAssignmentTitle)) === null;
    if (!cleared) await page.waitForTimeout(3000);
  }
  expect(cleared, "unreleasing a synced grade should clear the Canvas score").toBeTruthy();
  const { data: st2 } = await supabase
    .from("lti_grade_sync_state")
    .select("status, synced_score")
    .eq("assignment_id", pawAssignmentId)
    .eq("student_profile_id", studentId)
    .maybeSingle();
  expect(st2?.status, "state should be retracted after unrelease").toBe("retracted");
  expect(st2?.synced_score, "retracted state clears the synced score").toBeNull();
});

test("section discovery + auto-create + split roster sync place students in their Canvas sections", async ({
  browser,
  request
}) => {
  test.setTimeout(180_000);
  // Needs >= 2 Canvas sections with students to exercise split mapping.
  expect(cfg.sectionNames?.length ?? 0, "seed must create >= 2 Canvas sections").toBeGreaterThanOrEqual(2);

  // The context link captured at launch (bound to pawClassId in step 1).
  const { data: link } = await supabase
    .from("lti_context_links")
    .select("id")
    .eq("platform_id", platformId)
    .eq("deployment_id", cfg.deploymentId)
    .single();
  const contextLinkId = link!.id;

  // Treat this context as lab sections, split per member section.
  await supabase
    .from("lti_context_links")
    .update({ section_role: "lab", split_by_member_section: true, roster_sync_enabled: true })
    .eq("id", contextLinkId);

  // (a) Discovery: the live NRPS fetch must surface the Canvas section names.
  // This is the regression guard for the `rlid` fix — without it Canvas omits
  // the per-member `message[]`/`section_names` entirely and discovery is empty.
  // The endpoint requires an instructor/admin session, so launch the teacher.
  const tctx = await browser.newContext();
  try {
    const tpage = await tctx.newPage();
    await canvasLogin(tpage, cfg.teacher.email, cfg.teacher.password);
    await launchTool(tpage);
    // The launch establishes the instructor's tool session asynchronously; under
    // CI load it isn't always live the instant launchTool's fixed wait returns,
    // so the endpoint's authz check can briefly 403. Poll until the session is
    // ready (otherwise this step is flaky).
    let discBody: { sections?: string[]; error?: string } = {};
    let discOk = false;
    let discStatus = 0;
    for (let i = 0; i < 20 && !discOk; i++) {
      const discRes = await tpage.request.post(`${cfg.toolBaseUrl}/api/lti/context-sections`, {
        data: { context_link_id: contextLinkId }
      });
      discStatus = discRes.status();
      discBody = (await discRes.json()) as { sections?: string[]; error?: string };
      discOk = discRes.ok();
      if (!discOk) await tpage.waitForTimeout(3000);
    }
    expect(discOk, `discover ${discStatus}: ${JSON.stringify(discBody)}`).toBeTruthy();
    for (const name of cfg.sectionNames!) expect(discBody.sections ?? []).toContain(name);
  } finally {
    await tctx.close();
  }

  // (b) Auto-create: an admin creates Pawtograder sections from the Canvas
  // section names and maps them (admin-only RPC).
  const admin = await createUserInClass({ role: "admin", class_id: pawClassId });
  const { data: created, error: acErr } = await supabase.rpc("admin_create_lti_sections_from_canvas", {
    p_context_link_id: contextLinkId,
    p_section_names: cfg.sectionNames!,
    p_created_by: admin.user_id
  });
  expect(acErr, JSON.stringify(acErr)).toBeNull();
  expect((created ?? []).length).toBe(cfg.sectionNames!.length);
  for (const row of created ?? []) {
    expect(row.section_type).toBe("lab");
    expect(Number(row.sis_crn)).toBeGreaterThan(0);
  }
  const { data: maps } = await supabase
    .from("lti_context_section_map")
    .select("canvas_section_name, lab_section_id")
    .eq("context_link_id", contextLinkId);
  const nameToLabSection = new Map((maps ?? []).map((m) => [m.canvas_section_name, m.lab_section_id]));
  for (const name of cfg.sectionNames!) expect(nameToLabSection.get(name), `mapping for ${name}`).toBeTruthy();

  // (c) Re-sync the roster; students should now land in the lab section that
  // maps to their Canvas section.
  const syncRes = await request.post(`${cfg.toolBaseUrl}/api/lti/sync-roster`, {
    headers: { "x-lti-cron-secret": cronSecret },
    data: { all: true }
  });
  const syncJson = (await syncRes.json()) as { results?: { status: string; message: string }[] };
  expect(syncRes.ok(), `sync ${syncRes.status()}`).toBeTruthy();
  for (const r of syncJson.results ?? []) expect(r.status, r.message).toBe("success");

  // (d) Each student is placed in the lab section mapped from their Canvas
  // section — whether they already have an account (user_roles) or were invited.
  for (const student of cfg.students) {
    const canvasSection = cfg.studentSections?.[student.email];
    expect(canvasSection, `seed should record a section for ${student.email}`).toBeTruthy();
    const expectedLabSectionId = nameToLabSection.get(canvasSection!);
    expect(expectedLabSectionId, `mapped lab section for ${canvasSection}`).toBeTruthy();

    const { data: sUser } = await supabase.from("users").select("user_id").eq("email", student.email).maybeSingle();
    let actual: number | null | undefined;
    if (sUser) {
      const { data: role } = await supabase
        .from("user_roles")
        .select("lab_section_id")
        .eq("class_id", pawClassId)
        .eq("user_id", sUser.user_id)
        .maybeSingle();
      actual = role?.lab_section_id;
    }
    if (actual == null) {
      const { data: invite } = await supabase
        .from("invitations")
        .select("lab_section_id")
        .eq("class_id", pawClassId)
        .eq("email", student.email)
        .maybeSingle();
      actual = invite?.lab_section_id;
    }
    expect(actual, `${student.email} should be in the lab section for ${canvasSection}`).toBe(expectedLabSectionId);
  }
});

test("topology A: a context-level lecture section enrolls all students into that one section", async ({ request }) => {
  test.setTimeout(120_000);
  const { data: link } = await supabase
    .from("lti_context_links")
    .select("id")
    .eq("platform_id", platformId)
    .eq("deployment_id", cfg.deploymentId)
    .single();
  const contextLinkId = link!.id;

  // A lecture section with a CRN (only CRN-bearing sections are sync targets).
  const crn = 880000 + Math.floor(Math.random() * 100000);
  const { data: section, error: secErr } = await supabase
    .from("class_sections")
    .insert({ class_id: pawClassId, name: "E2E Lecture", sis_crn: crn })
    .select("id")
    .single();
  expect(secErr, JSON.stringify(secErr)).toBeNull();
  const lectureSectionId = section!.id as number;

  // Bind the context as a single lecture section (topology A; no split).
  await supabase
    .from("lti_context_links")
    .update({
      section_role: "lecture",
      split_by_member_section: false,
      class_section_id: lectureSectionId,
      lab_section_id: null,
      roster_sync_enabled: true
    })
    .eq("id", contextLinkId);

  const res = await request.post(`${cfg.toolBaseUrl}/api/lti/sync-roster`, {
    headers: { "x-lti-cron-secret": cronSecret },
    data: { all: true }
  });
  const body = (await res.json()) as { results?: { status: string; message: string }[] };
  expect(res.ok(), `sync ${res.status()}`).toBeTruthy();
  for (const r of body.results ?? []) expect(r.status, r.message).toBe("success");

  // Every student lands in that one lecture section (enrolled or invited).
  for (const student of cfg.students) {
    const { data: u } = await supabase.from("users").select("user_id").eq("email", student.email).maybeSingle();
    let actual: number | null | undefined;
    if (u) {
      const { data: role } = await supabase
        .from("user_roles")
        .select("class_section_id")
        .eq("class_id", pawClassId)
        .eq("user_id", u.user_id)
        .maybeSingle();
      actual = role?.class_section_id;
    }
    if (actual == null) {
      const { data: inv } = await supabase
        .from("invitations")
        .select("class_section_id")
        .eq("class_id", pawClassId)
        .eq("email", student.email)
        .maybeSingle();
      actual = inv?.class_section_id;
    }
    expect(actual, `${student.email} should be in the lecture section`).toBe(lectureSectionId);
  }
});

// MUST RUN LAST: this mutates the shared Canvas roster (removes a student).
test("roster drop: removing a Canvas enrollment drops the member on re-sync", async ({ request }) => {
  test.setTimeout(120_000);
  const auth = { Authorization: `Bearer ${cfg.canvasAdminToken}` };
  // The last student never launches, so they're an invited (sis-managed) member —
  // the cleanest drop signal is invitations.status -> 'dropped'.
  const target = cfg.students[cfg.students.length - 1].email;

  // Find the Canvas user + their student enrollment, then delete it.
  const uRes = await request.get(
    `${cfg.canvasBaseUrl}/api/v1/courses/${cfg.canvasCourseId}/users?search_term=${encodeURIComponent(target)}&per_page=100`,
    { headers: auth }
  );
  const cUser = ((await uRes.json()) as Array<{ id: number }>)[0];
  expect(cUser?.id, `Canvas user for ${target}`).toBeTruthy();
  const eRes = await request.get(
    `${cfg.canvasBaseUrl}/api/v1/courses/${cfg.canvasCourseId}/enrollments?user_id=${cUser.id}&per_page=100`,
    { headers: auth }
  );
  const enr = ((await eRes.json()) as Array<{ id: number; type: string }>).find((e) => e.type === "StudentEnrollment");
  expect(enr?.id, `enrollment for ${target}`).toBeTruthy();
  const dRes = await request.delete(
    `${cfg.canvasBaseUrl}/api/v1/courses/${cfg.canvasCourseId}/enrollments/${enr!.id}?task=delete`,
    { headers: auth }
  );
  expect(dRes.ok(), `delete enrollment ${dRes.status()}`).toBeTruthy();

  // Re-sync; the now-absent sis-managed member is dropped.
  const res = await request.post(`${cfg.toolBaseUrl}/api/lti/sync-roster`, {
    headers: { "x-lti-cron-secret": cronSecret },
    data: { all: true }
  });
  expect(res.ok(), `sync ${res.status()}`).toBeTruthy();

  // Their invitation is marked dropped (or, if they had an enrollment, disabled).
  const { data: inv } = await supabase
    .from("invitations")
    .select("status")
    .eq("class_id", pawClassId)
    .eq("email", target)
    .maybeSingle();
  const { data: u } = await supabase.from("users").select("user_id").eq("email", target).maybeSingle();
  let roleDisabled: boolean | null | undefined;
  if (u) {
    const { data: role } = await supabase
      .from("user_roles")
      .select("disabled")
      .eq("class_id", pawClassId)
      .eq("user_id", u.user_id)
      .maybeSingle();
    roleDisabled = role?.disabled;
  }
  expect(
    inv?.status === "dropped" || roleDisabled === true,
    `${target} should be dropped/disabled (invitation=${inv?.status}, disabled=${roleDisabled})`
  ).toBeTruthy();
});
