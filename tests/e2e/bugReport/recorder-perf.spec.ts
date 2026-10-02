/**
 * Package 1 performance tests (nightly tier): K1 and K2.
 *
 * K1 records the instructor gradebook (200 students) and the rubric grading page for
 * BUG_REPORT_K_MINUTES (default 10) of scripted use, reporting the buffer size at 5 and 10
 * minutes and main-thread long tasks. K2 runs the same script with the flag off as the
 * baseline. They take real time on purpose (long tasks can't be measured on a fake clock), so
 * they run only when BUG_REPORT_NIGHTLY=1. Chromium only: WebKit has no long-task APIs.
 *
 * "Recorder long tasks" is the long-task share of the wall-clock window with recording on (K1)
 * minus the same page's share with it off (K2, which runs first as the baseline). The result also
 * reports script time that LoAF attributes to the recorder and rrweb chunks; locally that
 * attribution came back 0 even with the chunks identified, so it is informational only.
 */
/* eslint-disable no-console -- page-side console calls are what the tests record, or measurements printed for the run log */
import { test, expect } from "../../global-setup";
import type { Page, TestInfo } from "@playwright/test";
import { addDays } from "date-fns";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import {
  createAssignmentsAndGradebookColumns,
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  setCourseFeature,
  type TestingUser
} from "../TestingUtils";
import { recorderStats, setTestRoutePolicy, waitForRecorderState } from "./recorderTestUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

const MINUTES = Number(process.env.BUG_REPORT_K_MINUTES ?? 10);
const BASELINE_MINUTES = Number(process.env.BUG_REPORT_K2_MINUTES ?? Math.min(MINUTES, 5));
const RECORDER_MARKER = "data-report-secret";

test.skip(process.env.BUG_REPORT_NIGHTLY !== "1", "nightly tier: set BUG_REPORT_NIGHTLY=1");

type Loaf = { start: number; duration: number; blocking: number; scripts: { url: string; duration: number }[] };

/** Script URLs of the recorder and rrweb chunks, per page; collected from before the first load. */
const recorderUrlsByPage = new WeakMap<Page, Set<string>>();

async function installPerfObservers(page: Page) {
  const recorderUrls = new Set<string>();
  recorderUrlsByPage.set(page, recorderUrls);
  page.on("response", async (r) => {
    if (!/\.js(\?|$)/.test(r.url())) return;
    const body = await r.text().catch(() => "");
    if (body.includes(RECORDER_MARKER) || body.includes("rr_mediaState")) recorderUrls.add(r.url());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __perf: { longTasks: { start: number; duration: number }[]; loaf: Loaf[] } };
    type Loaf = { start: number; duration: number; blocking: number; scripts: { url: string; duration: number }[] };
    w.__perf = { longTasks: [], loaf: [] };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__perf.longTasks.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: "longtask", buffered: true });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as {
          startTime: number;
          duration: number;
          blockingDuration: number;
          scripts: { sourceURL: string; duration: number }[];
        }[]) {
          w.__perf.loaf.push({
            start: e.startTime,
            duration: e.duration,
            blocking: e.blockingDuration,
            scripts: e.scripts.map((s) => ({ url: s.sourceURL, duration: s.duration }))
          });
        }
      }).observe({ type: "long-animation-frame", buffered: true });
    } catch {
      // Unsupported browser.
    }
  });
}

/** Scripted use: scroll the main scroll container, move and hover the pointer. */
async function scriptedUse(
  page: Page,
  scroller: string | null,
  minutes: number,
  onMinute: (m: number) => Promise<void>
) {
  const end = Date.now() + minutes * 60_000;
  let nextMinute = 1;
  let step = 0;
  const started = Date.now();
  while (Date.now() < end) {
    step++;
    const y = 150 + ((step * 37) % 400);
    const x = 200 + ((step * 53) % 700);
    await page.mouse.move(x, y, { steps: 5 });
    await page.mouse.wheel(0, step % 20 < 10 ? 400 : -400);
    if (scroller) {
      await page.evaluate(
        ([sel, dir]) => {
          const el = document.querySelector(sel as string);
          if (el) el.scrollBy({ top: (dir as number) * 300, left: (dir as number) * 120 });
        },
        [scroller, step % 20 < 10 ? 1 : -1] as const
      );
    }
    // Pace the script at roughly one step per second of real time.
    await page.waitForFunction((t) => Date.now() >= t, started + step * 1000, { polling: 100, timeout: 5_000 });
    while (Date.now() - started >= nextMinute * 60_000 && nextMinute <= minutes) {
      await onMinute(nextMinute);
      nextMinute++;
    }
  }
}

type Measurement = {
  page: string;
  recording: boolean;
  minutes: number;
  windowMs: number;
  longTaskMs: number;
  longTaskShare: number;
  loafScriptMsRecorder: number;
  recorderShare: number;
  bufferAt: Record<string, { size: number; segments: number; events: number }>;
};

async function measure(
  page: Page,
  testInfo: TestInfo,
  label: string,
  recording: boolean,
  minutes: number,
  scroller: string | null
): Promise<Measurement> {
  const recorderUrls = recorderUrlsByPage.get(page) ?? new Set<string>();
  if (recording) expect(recorderUrls.size).toBeGreaterThan(0);
  const t0 = await page.evaluate(() => performance.now());
  const bufferAt: Measurement["bufferAt"] = {};
  await scriptedUse(page, scroller, minutes, async (m) => {
    if (recording && (m === 5 || m === 10 || m === minutes)) {
      const s = await recorderStats(page);
      bufferAt[`${m}min`] = { size: s.size, segments: s.segments, events: s.events };
    }
  });
  const t1 = await page.evaluate(() => performance.now());
  const perf = await page.evaluate(
    () => (window as unknown as { __perf: { longTasks: { start: number; duration: number }[]; loaf: Loaf[] } }).__perf
  );
  const inWindow = <T extends { start: number }>(xs: T[]) => xs.filter((x) => x.start >= t0 && x.start <= t1);
  const longTaskMs = inWindow(perf.longTasks).reduce((n, t) => n + t.duration, 0);
  const loafScriptMsRecorder = inWindow(perf.loaf)
    .flatMap((f) => f.scripts)
    .filter((s) => recorderUrls.has(s.url))
    .reduce((n, s) => n + s.duration, 0);
  const windowMs = t1 - t0;
  const result: Measurement = {
    page: label,
    recording,
    minutes,
    windowMs: Math.round(windowMs),
    longTaskMs: Math.round(longTaskMs),
    longTaskShare: longTaskMs / windowMs,
    loafScriptMsRecorder: Math.round(loafScriptMsRecorder),
    recorderShare: loafScriptMsRecorder / windowMs,
    bufferAt
  };
  console.log(`[bug-report K] ${JSON.stringify(result)}`);
  await testInfo.attach(`${label}-${recording ? "K1" : "K2"}.json`, {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json"
  });
  return result;
}

test.describe("bug report recorder performance", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(({ browserName }) => browserName !== "chromium", "long-task APIs are Chromium-only");

  let gradebookCourse: Course;
  let gradingCourse: Course;
  let gradebookInstructor: TestingUser;
  let gradingInstructor: TestingUser;
  let gradingUrl: string;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    gradebookCourse = await createClass({ name: "Bug Report K Gradebook" });
    [gradebookInstructor] = await createUsersInClass([
      { role: "instructor", class_id: gradebookCourse.id, name: "K Gradebook Instructor", useMagicLink: true }
    ]);
    // In batches: createUsersInClass looks existing users up with one GET, whose URL gets too
    // long past a few dozen emails.
    for (let batch = 0; batch < 200; batch += 25) {
      await createUsersInClass(
        Array.from({ length: 25 }, (_, i) => ({
          role: "student" as const,
          class_id: gradebookCourse.id,
          name: `K Student ${String(batch + i).padStart(3, "0")}`
        }))
      );
    }
    await createAssignmentsAndGradebookColumns({
      class_id: gradebookCourse.id,
      numAssignments: 5,
      numManualGradedColumns: 3
    });

    gradingCourse = await createClass({ name: "Bug Report K Grading" });
    const [student, instructor] = await createUsersInClass([
      { role: "student", class_id: gradingCourse.id, name: "K Grading Student", useMagicLink: true },
      { role: "instructor", class_id: gradingCourse.id, name: "K Grading Instructor", useMagicLink: true }
    ]);
    gradingInstructor = instructor;
    const assignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: gradingCourse.id,
      name: "K Grading Assignment"
    });
    const { submission_id } = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: gradingCourse.id
    });
    gradingUrl = `/course/${gradingCourse.id}/assignments/${assignment.id}/submissions/${submission_id}/files`;
  });

  const results: Measurement[] = [];

  function expectRecorderShareUnderBudget(k1: Measurement) {
    const k2 = results.find((m) => m.page === k1.page && !m.recording);
    const delta = k2 ? k1.longTaskShare - k2.longTaskShare : k1.longTaskShare;
    console.log(`[bug-report K] ${k1.page}: recorder long-task share ${(delta * 100).toFixed(2)}%`);
    expect(delta).toBeLessThan(0.05);
  }

  test.afterAll(async () => {
    console.log(`[bug-report K summary] ${JSON.stringify(results)}`);
  });

  // Baseline (K2) first, so K1 can compare against it.
  for (const recording of [false, true]) {
    const id = recording ? "K1" : "K2";
    const minutes = recording ? MINUTES : BASELINE_MINUTES;

    test(`${id}: gradebook, 200 students, recording ${recording ? "on" : "off"}`, async ({ page }, testInfo) => {
      test.setTimeout((minutes + 5) * 60_000);
      await setCourseFeature(gradebookCourse.id, COURSE_FEATURES.BUG_REPORT_RECORDING, recording);
      await setTestRoutePolicy(page, [{ pattern: "/course/[course_id]/manage/gradebook", level: "structure" }]);
      await installPerfObservers(page);
      await loginAsUser(page, gradebookInstructor, gradebookCourse);
      await page.goto(`/course/${gradebookCourse.id}/manage/gradebook`);
      await expect(page.getByText("K Student 000").first()).toBeVisible({ timeout: 60_000 });
      if (recording) await waitForRecorderState(page, "recording");
      else expect(await page.evaluate(() => window.__bugReportRecorder)).toBeUndefined();
      const r = await measure(
        page,
        testInfo,
        "gradebook",
        recording,
        minutes,
        '[role="region"][aria-label="Instructor Gradebook Table"]'
      );
      results.push(r);
      if (recording) expectRecorderShareUnderBudget(r);
    });

    test(`${id}: rubric grading page, recording ${recording ? "on" : "off"}`, async ({ page }, testInfo) => {
      test.setTimeout((minutes + 5) * 60_000);
      await setCourseFeature(gradingCourse.id, COURSE_FEATURES.BUG_REPORT_RECORDING, recording);
      await setTestRoutePolicy(page, [
        {
          pattern: "/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/files",
          level: "structure"
        }
      ]);
      await installPerfObservers(page);
      await loginAsUser(page, gradingInstructor, gradingCourse);
      await page.goto(gradingUrl);
      await expect(page.getByText("public static void main(")).toBeVisible({ timeout: 60_000 });
      if (recording) await waitForRecorderState(page, "recording");
      else expect(await page.evaluate(() => window.__bugReportRecorder)).toBeUndefined();
      const r = await measure(page, testInfo, "rubric-grading", recording, minutes, null);
      results.push(r);
      if (recording) expectRecorderShareUnderBudget(r);
    });
  }
});
