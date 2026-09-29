/**
 * Leak tests for the taint ingest (package 2, PR tier): D1, D2, D4, D5, D6, D7, D16.
 *
 * Each test opens a page of a canary class with recording on and checks two things:
 *
 * - every canary the page renders (text and text attributes) is in the recorder's taint set,
 *   through the E2E-only `window.__bugReportTaint`. This pins a leak on the ingest point that
 *   missed it rather than on the redaction pass;
 * - `scanForCanaries(redactedUploadBytes(page)) = []`: the would-be upload, redacted by package
 *   3's worker with this taint set, holds no canary (spec §7.3).
 *
 * Needs a build made with E2E_ENABLE=true (test route policy and the test hooks). No Sentry.
 */
/* eslint-disable no-console -- measurements printed for the run log */
import type { Page } from "@playwright/test";
import { expect, test } from "@/tests/global-setup";
import type { RoutePolicyEntry } from "@/lib/bugReport/routePolicy";
import { addDays } from "date-fns";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertHelpRequest,
  loginAsUser,
  supabase,
  type TestingUser
} from "../TestingUtils";
import { canarySentence, registerCanary, resolveCanary } from "./canaryRegistry";
import { describeHits, scanForCanaries, type CanaryHit } from "./canaries";
import { seedCanaryClass, type CanarySeed } from "./canarySeed";
import { enableBugReports, waitForRecorderState } from "./recorderTestUtils";
import { redactedUploadBytes } from "./report";

test.describe.configure({ mode: "default" });

const POLICY: RoutePolicyEntry[] = [
  { pattern: "/course/[course_id]/manage/course/enrollments", level: "structure" },
  { pattern: "/course/[course_id]/manage/assignments/[assignment_id]/groups", level: "structure" },
  { pattern: "/course/[course_id]/manage/gradebook", level: "structure" },
  { pattern: "/course/[course_id]/manage/student/[student_id]", level: "structure" },
  { pattern: "/course/[course_id]/manage/office-hours", level: "structure" },
  { pattern: "/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]", level: "structure" }
];

let seed: CanarySeed;
let groupName: string;
let groupsUrl: string;

test.beforeAll(async () => {
  seed = await seedCanaryClass();
  // A group with a mentor, so the groups page's `mentor:profiles!…(name)` embed carries a name.
  const groupAssignment = await insertAssignment({
    due_date: addDays(new Date(), 7).toUTCString(),
    class_id: seed.course.id,
    name: "Canary Group Assignment",
    group_config: "groups",
    min_group_size: 1,
    max_group_size: 3
  });
  groupsUrl = `/course/${seed.course.id}/manage/assignments/${groupAssignment.id}/groups`;
  groupName = `grp-${canarySentence().anchor}`;
  const { data: group, error } = await supabase
    .from("assignment_groups")
    .insert({
      class_id: seed.course.id,
      assignment_id: groupAssignment.id,
      name: groupName,
      mentor_profile_id: seed.grader.private_profile_id
    })
    .select("id")
    .single();
  if (error || !group) throw new Error(`group insert failed: ${error?.message}`);
  const { error: memberError } = await supabase.from("assignment_groups_members").insert({
    class_id: seed.course.id,
    assignment_id: groupAssignment.id,
    assignment_group_id: group.id,
    profile_id: seed.students[2 % seed.students.length].private_profile_id,
    added_by: seed.instructor.private_profile_id
  });
  if (memberError) throw new Error(`group member insert failed: ${memberError.message}`);
  registerCanary(resolveCanary({ registry: seed.registry })!, groupName, {
    kind: "free_text",
    column: "assignment_groups.name",
    rowId: group.id
  });
});

type TaintStats = { taint: { patterns: number; chars: number }; ingest: Record<string, number> };

async function openRecorded(page: Page, user: TestingUser, url: string): Promise<void> {
  await enableBugReports(page, seed.course.id, POLICY);
  await loginAsUser(page, user, seed.course);
  await page.goto(url);
  await waitForRecorderState(page, "recording");
  await page.waitForFunction(() => window.__bugReportTaint !== undefined);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() => window.__bugReportTaint!.idle());
}

async function taintHas(page: Page, values: string[]): Promise<string[]> {
  return page.evaluate((vs) => vs.filter((v) => !window.__bugReportTaint!.has(v)), values);
}

async function taintStats(page: Page): Promise<TaintStats> {
  return page.evaluate(() => window.__bugReportTaint!.stats() as unknown as TaintStats);
}

/** Visible text plus the text attributes the recorder masks (the would-be recorded strings). */
async function renderedStrings(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts = [document.title, document.body.innerText];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      for (const name of ["title", "aria-label", "alt", "placeholder", "href", "value"]) {
        const v = el.getAttribute(name);
        if (v) parts.push(v);
      }
    }
    return parts.join("\n");
  });
}

/**
 * Every non-grade canary on the page must be in the taint set, as the variant that matched or
 * as the whole value. Grades are blocked structurally and never string-matched (package 3).
 * Returns the canaries found, so a test can also require specific ones.
 */
async function expectRenderedCanariesTainted(page: Page, minHits = 1): Promise<Set<string>> {
  await settle(page);
  const hits = scanForCanaries(await renderedStrings(page), seed.registry).filter((h) => h.entry.kind !== "grade");
  expect(hits.length, "the page should render some canaries, or the test proves nothing").toBeGreaterThanOrEqual(
    minHits
  );
  const byCanary = new Map<string, Set<string>>();
  for (const h of hits) byCanary.set(h.canary, (byCanary.get(h.canary) ?? new Set()).add(h.matched));
  const missing: string[] = [];
  for (const [canary, matched] of byCanary) {
    const absent = await taintHas(page, [canary, ...matched]);
    // Tainted when the whole value is, or every matched variant is.
    if (absent.includes(canary) && [...matched].some((m) => absent.includes(m))) {
      const entry = seed.registry.get(canary)!;
      missing.push(`${entry.kind} ${entry.column}: ${[...matched].filter((m) => absent.includes(m)).join(" | ")}`);
    }
  }
  expect(missing, "rendered canaries missing from the taint set").toEqual([]);
  return new Set(byCanary.keys());
}

/** The spec's final assertion: no canary in any would-be uploaded byte. */
async function expectNoCanariesUploaded(page: Page): Promise<void> {
  await settle(page);
  const bytes = new TextDecoder().decode(await redactedUploadBytes(page));
  const hits = scanForCanaries(bytes, seed.registry).filter((h) => !numberFragment(bytes, h));
  expect(hits, describeHits(hits)).toEqual([]);
}

/**
 * A grade canary such as "72.52" found inside a longer number (an SVG path's "M572.52 241.4") is
 * a coincidence, not the grade: the scan matches substrings. Only grade hits with a digit, or a
 * digit-and-dot, right next to them are dropped.
 */
function numberFragment(text: string, hit: CanaryHit): boolean {
  if (hit.entry.kind !== "grade") return false;
  const before = text[hit.offset - 1] ?? "";
  const after = text[hit.offset + hit.matched.length] ?? "";
  return /[\d.]/.test(before) || /\d/.test(after);
}

/** The seeded discussion thread's subject, which the discussion page lists once it has loaded. */
async function waitForDiscussion(page: Page): Promise<void> {
  const subject = canariesOf("discussion_threads.subject")[0];
  await expect(page.getByText(subject).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
}

function canariesOf(column: string): string[] {
  return [...seed.registry].filter(([, e]) => e.column === column).map(([v]) => v);
}

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([seed.instructor, seed.grader, ...seed.students]);
});

test("D1: roster on the instructor enrollments page", async ({ page }) => {
  await openRecorded(page, seed.instructor, seed.routes.manageEnrollments);
  await expect(page.getByText(seed.students[0].private_profile_name).filter({ visible: true }).first()).toBeVisible({
    timeout: 30_000
  });
  const found = await expectRenderedCanariesTainted(page, 3);
  expect(found.has(seed.students[0].private_profile_name)).toBe(true);
  const stats = await taintStats(page);
  console.log(`D1 enrollments: ${JSON.stringify(stats)}`);
  await expectNoCanariesUploaded(page);
});

test("D1: roster hydrated into TableControllers for a student (initialData)", async ({ page }) => {
  await openRecorded(page, seed.students[0], seed.routes.discussion);
  await waitForDiscussion(page);
  await expectRenderedCanariesTainted(page, 1);
  // The start-up backfill of live controllers ran, and the staff's names from the server-hydrated
  // roster are in the set whether or not this page shows them.
  const stats = await taintStats(page);
  expect(stats.ingest.rowBatches).toBeGreaterThan(0);
  expect(await taintHas(page, [seed.instructor.private_profile_name])).toEqual([]);
  await expectNoCanariesUploaded(page);
});

test("D1 + D2: groups page, with the mentor alias embed", async ({ page }) => {
  await openRecorded(page, seed.instructor, groupsUrl);
  await expect(page.getByText(groupName).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await expectRenderedCanariesTainted(page, 2);
  // `mentor:profiles!assignment_groups_mentor_profile_id_fkey(name)` resolved to profiles.name.
  expect(await taintHas(page, [seed.grader.private_profile_name, groupName])).toEqual([]);
  await expectNoCanariesUploaded(page);
});

test("D4: a help request created during recording arrives as a full-row broadcast", async ({ page }) => {
  await openRecorded(page, seed.instructor, seed.routes.manageOfficeHours);
  await settle(page);
  const before = await taintStats(page);
  const request = canarySentence();
  const created = await insertHelpRequest({
    class_id: seed.course.id,
    student_profile_id: seed.students[1].private_profile_id,
    request: request.text
  });
  registerCanary(resolveCanary({ registry: seed.registry })!, request.text, {
    kind: "free_text",
    column: "help_requests.request",
    rowId: created.id,
    anchors: [request.anchor]
  });
  await page.waitForFunction((v) => window.__bugReportTaint!.has(v), request.text, { timeout: 30_000 });
  const after = await taintStats(page);
  expect(after.ingest.broadcasts + after.ingest.responses).toBeGreaterThan(
    before.ingest.broadcasts + before.ingest.responses
  );
  await expectRenderedCanariesTainted(page, 1);
  await expectNoCanariesUploaded(page);
});

test("D5: an ID-only gradebook broadcast refetches through the fetch hook", async ({ page }) => {
  await openRecorded(page, seed.instructor, seed.routes.manageGradebook);
  await expect(page.getByText(seed.students[0].private_profile_name).filter({ visible: true }).first()).toBeVisible({
    timeout: 30_000
  });
  await settle(page);
  const before = await taintStats(page);
  const note = canarySentence();
  const { data: cells, error } = await supabase
    .from("gradebook_column_students")
    .select("id, gradebook_column_id")
    .eq("class_id", seed.course.id)
    .eq("student_id", seed.students[0].private_profile_id)
    .eq("is_private", true)
    .limit(1);
  if (error || !cells?.length) throw new Error(`cell lookup failed: ${error?.message}`);
  const { error: updateError } = await supabase
    .from("gradebook_column_students")
    .update({ score_override: 91.17, score_override_note: note.text })
    .eq("id", cells[0].id);
  if (updateError) throw new Error(updateError.message);
  registerCanary(resolveCanary({ registry: seed.registry })!, note.text, {
    kind: "free_text",
    column: "gradebook_column_students.score_override_note",
    rowId: cells[0].id,
    anchors: [note.anchor]
  });
  await page.waitForFunction((v) => window.__bugReportTaint!.has(v), note.text, { timeout: 30_000 });
  const after = await taintStats(page);
  expect(after.ingest.responses + after.ingest.broadcasts).toBeGreaterThan(
    before.ingest.responses + before.ingest.broadcasts
  );
  await expectRenderedCanariesTainted(page, 3);
  await expectNoCanariesUploaded(page);
});

test("D6: the student page backed by get_student_summary", async ({ page }) => {
  const summary = page.waitForResponse((r) => r.url().includes("/rest/v1/rpc/get_student_summary"));
  await openRecorded(page, seed.instructor, seed.routes.manageStudent);
  await summary;
  const found = await expectRenderedCanariesTainted(page, 1);
  // The help request in the Json summary, whether or not the page shows it.
  expect(await taintHas(page, canariesOf("help_requests.request").slice(0, 1))).toEqual([]);
  console.log(`D6 found ${found.size} canaries`);
  await expectNoCanariesUploaded(page);
});

test("D7: an edge-function payload with GitHub usernames (commit history)", async ({ page }) => {
  const handle = canariesOf("users.github_username").find(Boolean);
  expect(handle, "the seed sets github usernames").toBeTruthy();
  const authorName = `Commit ${canarySentence().anchor} Author`;
  registerCanary(resolveCanary({ registry: seed.registry })!, authorName, {
    kind: "name",
    column: "edge:repository-list-commits $.commits[*].commit.author.name",
    rowId: 0
  });
  // The real function calls GitHub; the stub returns the same shape.
  await page.route("**/functions/v1/repository-list-commits", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        commits: [
          {
            sha: "0123456789abcdef0123456789abcdef01234567",
            html_url: "https://github.example/c/1",
            commit: {
              message: "Fix the loop",
              author: { name: authorName, email: `${handle}@users.noreply.example`, date: new Date().toISOString() },
              committer: { name: authorName, email: `${handle}@users.noreply.example`, date: new Date().toISOString() }
            },
            author: { login: handle, id: 4242, avatar_url: "https://avatars.example/u/4242" }
          }
        ],
        has_more: false
      })
    })
  );
  await openRecorded(page, seed.instructor, seed.routes.studentSubmission);
  const edge = page.waitForResponse((r) => r.url().includes("/functions/v1/repository-list-commits"));
  await page
    .getByRole("button", { name: /commit history/i })
    .first()
    .click();
  await edge;
  await settle(page);
  expect(await taintHas(page, [handle!, authorName])).toEqual([]);
  await expectRenderedCanariesTainted(page, 1);
  await expectNoCanariesUploaded(page);
});

test("D16: the reporter's own name and email from the auth session", async ({ page }) => {
  const me = seed.students[1];
  await openRecorded(page, me, seed.routes.discussion);
  await waitForDiscussion(page);
  await settle(page);
  expect(await taintHas(page, [me.email, me.email.split("@")[0], me.private_profile_name])).toEqual([]);
  await expectRenderedCanariesTainted(page, 1);
  await expectNoCanariesUploaded(page);
});

/** Counts `Response.prototype.clone` calls from page load on. */
async function countClones(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __clones: number };
    w.__clones = 0;
    const original = Response.prototype.clone;
    Response.prototype.clone = function (this: Response) {
      w.__clones++;
      return original.call(this);
    };
  });
}

test("flag off on a listed route: no response is cloned, nothing is armed", async ({ page }) => {
  const course = await createClass({ name: "Bug Report Ingest Flag Off" });
  const [student] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Flag Off Student", useMagicLink: true }
  ]);
  await countClones(page);
  await loginAsUser(page, student, course);
  // Listed in the production policy; the flag is off by default.
  await page.goto(`/course/${course.id}/discussion`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  expect(await page.evaluate(() => window.__bugReportRecorder)).toBeUndefined();
  expect(await page.evaluate(() => window.__bugReportTaint)).toBeUndefined();
  expect(await page.evaluate(() => (window as unknown as { __clones: number }).__clones)).toBe(0);
});

test("flag on: the same count sees the ingest's clones (control for the test above)", async ({ page }) => {
  await countClones(page);
  await openRecorded(page, seed.students[0], seed.routes.discussion);
  await waitForDiscussion(page);
  await settle(page);
  expect(await page.evaluate(() => (window as unknown as { __clones: number }).__clones)).toBeGreaterThan(0);
});
