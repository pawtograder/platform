/**
 * A client navigation from one recorded course to another, in one tab (PR tier).
 *
 * Course B's layout renders, and its first fetches start, while course A's recorder is still
 * running. The mount then stops A's recorder, which clears the taint set, and starts B's. The
 * pre-start buffer must arm for B even though A's ingest is the sink at that moment, and must
 * hand B's first responses to B's ingest. Otherwise data B loaded outside a TableController (RPCs,
 * edge functions, direct queries) is on screen and never tainted.
 *
 * Needs a build made with E2E_ENABLE=true. No Sentry.
 */
import { expect, test } from "@/tests/global-setup";
import type { RoutePolicyEntry } from "@/lib/bugReport/routePolicy";
import { createClass, createUserInClass, loginAsUser } from "../TestingUtils";
import { describeHits, scanForCanaries } from "./canaries";
import { seedCanaryClass, type CanarySeed } from "./canarySeed";
import { enableBugReports, waitForRecorderState } from "./recorderTestUtils";
import { redactedUploadBytes } from "./report";

const POLICY: RoutePolicyEntry[] = [
  { pattern: "/course/[course_id]/manage/course/enrollments", level: "structure" },
  { pattern: "/course/[course_id]/manage/student/[student_id]", level: "structure" }
];

let seed: CanarySeed;
let courseA: Awaited<ReturnType<typeof createClass>>;

test.beforeAll(async () => {
  // Course B is the canary class; the same instructor also teaches course A.
  seed = await seedCanaryClass();
  courseA = await createClass({ name: "Course Switch A" });
  await createUserInClass({
    role: "instructor",
    class_id: courseA.id,
    email: seed.instructor.email,
    name: seed.instructor.private_profile_name,
    public_profile_name: seed.instructor.public_profile_name,
    canary: false
  });
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([seed.instructor]);
});

test("course switch: B's RPC data is tainted after a client navigation from recorded course A", async ({ page }) => {
  await enableBugReports(page, courseA.id, POLICY);
  await enableBugReports(page, seed.course.id);
  await loginAsUser(page, seed.instructor, courseA);
  await page.goto(`/course/${courseA.id}/manage/course/enrollments`);
  await waitForRecorderState(page, "recording");
  expect(await page.evaluate(() => window.__bugReportRecorder!.getCourseId())).toBe(courseA.id);
  await page.waitForFunction(() => window.__bugReportTaint !== undefined);

  const summaryCanaries = [...seed.registry]
    .filter(([, e]) => e.column === "help_requests.request")
    .map(([value]) => value);
  expect(summaryCanaries.length, "the seed has a help request").toBeGreaterThan(0);

  const summary = page.waitForResponse((r) => r.url().includes("/rest/v1/rpc/get_student_summary"));
  const loadsBefore = await page.evaluate(() => performance.getEntriesByType("navigation").length);
  const target = seed.routes.manageStudent;
  await page.evaluate((href) => {
    const router = (window as unknown as { next?: { router?: { push(href: string): void } } }).next?.router;
    if (!router) throw new Error("no app router");
    router.push(href);
  }, target);
  await page.waitForURL((u) => u.pathname === target);
  const body = await (await summary).text();
  expect(body, "the RPC carries the help request").toContain(summaryCanaries[0]);

  await page.waitForFunction(
    (id) => window.__bugReportRecorder?.getCourseId() === id && window.__bugReportRecorder.getState() === "recording",
    seed.course.id,
    { timeout: 20_000 }
  );
  // Still one document: this was a client navigation.
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(loadsBefore);
  await page.waitForFunction(() => window.__bugReportTaint !== undefined);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() => window.__bugReportTaint!.idle());

  const missing = await page.evaluate(
    (values) => values.filter((v) => !window.__bugReportTaint!.has(v)),
    summaryCanaries.slice(0, 1)
  );
  expect(missing, "course B's get_student_summary canary is in the taint set").toEqual([]);

  const bytes = new TextDecoder().decode(await redactedUploadBytes(page));
  const hits = scanForCanaries(bytes, seed.registry);
  expect(hits, describeHits(hits)).toEqual([]);
});
