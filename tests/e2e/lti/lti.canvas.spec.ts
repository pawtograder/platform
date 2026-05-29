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
import { createClass, createAssignmentsAndGradebookColumns } from "../TestingUtils";
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
  students: { email: string; password: string }[];
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

  // Show the synced roster in the management UI (teacher session from step 1).
  await page.goto(`${cfg.toolBaseUrl}/course/${pawClassId}/manage/course/lti`, { waitUntil: "domcontentloaded" });
  await visualScreenshot(page, "lti-02-roster-synced");
});

test("student launch is adopted, then a grade is pushed to Canvas (AGS)", async ({ browser, page, request }) => {
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

  await supabase
    .from("gradebook_column_students")
    .update({ score: 88, released: true })
    .eq("gradebook_column_id", gradebookColumnId)
    .eq("student_id", sRole!.private_profile_id)
    .eq("is_private", true);

  // Push grades to Canvas via AGS.
  const pushRes = await request.post(`${cfg.toolBaseUrl}/api/lti/push-grades`, {
    headers: { "x-lti-cron-secret": cronSecret },
    data: { class_id: pawClassId, assignment_id: pawAssignmentId }
  });
  const pushBody = await pushRes.json();
  expect(pushRes.ok(), JSON.stringify(pushBody)).toBeTruthy();
  expect(pushBody.pushed).toBeGreaterThanOrEqual(1);

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
