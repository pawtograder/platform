/**
 * Taint trace tour (test I1's seed coverage): one canary class, visited page by page as a student,
 * a grader, and an instructor, so every kind of seeded PII has a chance to reach a source and a
 * sink. Runs only under BUG_REPORT_TRACE=1; the trace fixture does the recording.
 */
import { expect, test } from "@/tests/global-setup";
import type { Page } from "@playwright/test";
import { loginAsUser, supabase, type TestingUser } from "../TestingUtils";
import { canarySentence, isTraceMode, registerCanary, resolveCanary } from "./canaryRegistry";
import { seedCanaryClass, type CanarySeed } from "./canarySeed";
import { workerTracer } from "./traceFixture";

test.describe.configure({ mode: "serial" });
test.skip(!isTraceMode(), "taint trace tour runs only under BUG_REPORT_TRACE=1");

let seed: CanarySeed;

test.beforeAll(async () => {
  seed = await seedCanaryClass();
});

async function visit(page: Page, url: string) {
  const response = await page.goto(url);
  expect(response?.status() ?? 200, `${url} should load`).toBeLessThan(500);
  await workerTracer.settle(page);
}

async function tour(page: Page, user: TestingUser, routes: (keyof CanarySeed["routes"])[]) {
  await loginAsUser(page, user, seed.course);
  for (const r of routes) await visit(page, seed.routes[r]);
}

test("student pages", async ({ page }) => {
  await tour(page, seed.students[0], [
    "studentDashboard",
    "studentAssignments",
    "studentAssignment",
    "studentSubmission",
    "studentGrade",
    "studentGradebook",
    "officeHours",
    "helpRequest",
    "discussion",
    "discussionThread"
  ]);
});

test("second student pages", async ({ page }) => {
  await tour(page, seed.students[1], ["studentGradebook", "discussion", "discussionThread", "officeHours"]);
});

test("grader pages", async ({ page }) => {
  await tour(page, seed.grader, ["graderSubmission", "graderSubmissionFiles", "manageOfficeHours", "discussionThread"]);
});

test("instructor pages", async ({ page }) => {
  await tour(page, seed.instructor, [
    "manageDashboard",
    "manageAssignments",
    "manageAssignment",
    "manageGroups",
    "graderSubmission",
    "manageGradebook",
    "manageEnrollments",
    "manageStudent",
    "manageOfficeHours",
    "manageHelpRequest",
    "manageDiscussionEngagement",
    "discussionThread"
  ]);
});

test("realtime: a help request message arrives while staff watch the request", async ({ page }) => {
  await loginAsUser(page, seed.instructor, seed.course);
  await visit(page, seed.routes.manageHelpRequest);
  const message = canarySentence();
  const { data, error } = await supabase
    .from("help_request_messages")
    .insert({
      class_id: seed.course.id,
      help_request_id: seed.ids.helpRequestId,
      author: seed.students[0].private_profile_id,
      message: message.text
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert failed: ${error?.message}`);
  registerCanary(resolveCanary({ registry: seed.registry })!, message.text, {
    kind: "free_text",
    column: "help_request_messages.message",
    rowId: data.id,
    anchors: [message.anchor]
  });
  await expect(page.getByText(message.text).first()).toBeVisible({ timeout: 30_000 });
  await workerTracer.settle(page);
});
