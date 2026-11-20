/**
 * Package 3 measurement: redaction time for a 3- and a 10-minute buffer on the instructor
 * gradebook (200 students) and the discussion page, in the worker. Package 5b's K3 budget is
 * 5 s from dialog open to preview ready, and redaction is most of it.
 *
 * The clock is faked: every step scrolls or changes the page and advances 5 s, so the recorder
 * takes a checkout per minute the way it would in real use. Runs only with
 * BUG_REPORT_MEASURE=1; prints `[bug-report redaction perf]` lines for the PR.
 */
/* eslint-disable no-console -- measurements printed for the run log */
import type { Page } from "@playwright/test";
import { test, expect } from "../../global-setup";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import {
  createAssignmentsAndGradebookColumns,
  createClass,
  createUsersInClass,
  loginAsUser,
  setCourseFeature,
  supabase,
  type TestingUser
} from "../TestingUtils";
import { setTestRoutePolicy, waitForRecorderState } from "./recorderTestUtils";
import type { RedactionMeasurement } from "@/lib/bugReport/redaction/testHook";

test.skip(process.env.BUG_REPORT_MEASURE !== "1", "measurement: set BUG_REPORT_MEASURE=1");

type Course = Awaited<ReturnType<typeof createClass>>;

async function measure(page: Page, minutes: number, step: (i: number) => Promise<void>) {
  const results: Record<string, RedactionMeasurement> = {};
  for (let i = 0; i < minutes * 12; i++) {
    await step(i);
    await page.clock.fastForward(5_000);
    const elapsed = (i + 1) * 5;
    if (elapsed === 180 || elapsed === minutes * 60) {
      // A DOM change after the last tick, so the buffer's last segment is current.
      await page.evaluate(() => document.body.appendChild(document.createElement("span")));
      const runs: RedactionMeasurement[] = [];
      for (let r = 0; r < 3; r++) runs.push(await page.evaluate(() => window.__bugReportRedaction!.measure()));
      results[`${elapsed / 60}min`] = runs.sort((a, b) => a.totalMs - b.totalMs)[1];
    }
  }
  return results;
}

test.describe("bug report redaction timing", () => {
  let gradebookCourse: Course;
  let gradebookInstructor: TestingUser;
  let discussionCourse: Course;
  let discussionStudent: TestingUser;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    gradebookCourse = await createClass({ name: "Bug Report Redaction Gradebook" });
    // In batches: one call with 200 users overflows the existence check's URL.
    const users = await createUsersInClass([
      { role: "instructor", class_id: gradebookCourse.id, name: "Redaction Gradebook Instructor", useMagicLink: true }
    ]);
    for (let b = 0; b < 4; b++) {
      await createUsersInClass(
        Array.from({ length: 50 }, (_, i) => ({
          role: "student" as const,
          class_id: gradebookCourse.id,
          name: `R Student ${String(b * 50 + i).padStart(3, "0")}`
        }))
      );
    }
    gradebookInstructor = users[0];
    await createAssignmentsAndGradebookColumns({
      class_id: gradebookCourse.id,
      numAssignments: 5,
      numManualGradedColumns: 3
    });

    discussionCourse = await createClass({ name: "Bug Report Redaction Discussion" });
    const [student, ...others] = await createUsersInClass([
      { role: "student", class_id: discussionCourse.id, name: "Redaction Discussion Student", useMagicLink: true },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: "student" as const,
        class_id: discussionCourse.id,
        name: `D Poster ${i}`
      }))
    ]);
    discussionStudent = student;
    const { data: topic } = await supabase
      .from("discussion_topics")
      .select("id")
      .eq("class_id", discussionCourse.id)
      .order("ordinal")
      .limit(1)
      .single();
    const rows = Array.from({ length: 80 }, (_, i) => ({
      subject: `Question ${i} about the assignment`,
      body: `Post ${i}: ${"I tried the approach from lecture and it still fails on the edge case. ".repeat(4)}`,
      topic_id: topic!.id,
      is_question: i % 2 === 0,
      instructors_only: false,
      author: others[i % others.length].public_profile_id,
      class_id: discussionCourse.id,
      draft: false,
      root_class_id: discussionCourse.id
    }));
    const { error } = await supabase.from("discussion_threads").insert(rows);
    if (error) throw new Error(error.message);
  });

  const summary: Record<string, unknown> = {};
  test.afterAll(() => {
    console.log(`[bug-report redaction perf] ${JSON.stringify(summary)}`);
  });

  test("gradebook, 200 students: 3- and 10-minute buffers", async ({ page }) => {
    test.setTimeout(900_000);
    await setCourseFeature(gradebookCourse.id, COURSE_FEATURES.BUG_REPORT_RECORDING, true);
    await setTestRoutePolicy(page, [{ pattern: "/course/[course_id]/manage/gradebook", level: "structure" }]);
    await page.clock.install();
    await loginAsUser(page, gradebookInstructor, gradebookCourse);
    await page.goto(`/course/${gradebookCourse.id}/manage/gradebook`);
    await expect(page.getByText("R Student 000").first()).toBeVisible({ timeout: 60_000 });
    await waitForRecorderState(page, "recording");
    const scroller = '[role="region"][aria-label="Instructor Gradebook Table"]';
    const results = await measure(page, 10, async (i) => {
      await page.evaluate(
        ([sel, dir]) => document.querySelector(sel as string)?.scrollBy({ top: (dir as number) * 600, left: 0 }),
        [scroller, i % 20 < 10 ? 1 : -1] as const
      );
      await page.mouse.move(200 + ((i * 53) % 700), 150 + ((i * 37) % 400));
    });
    summary.gradebook = results;
    console.log(`[bug-report redaction perf] gradebook ${JSON.stringify(results)}`);
    for (const r of Object.values(results)) expect(r.worker).toBe(true);
  });

  test("discussion: 3- and 10-minute buffers", async ({ page }) => {
    test.setTimeout(900_000);
    await setCourseFeature(discussionCourse.id, COURSE_FEATURES.BUG_REPORT_RECORDING, true);
    await page.clock.install();
    await loginAsUser(page, discussionStudent, discussionCourse);
    await page.goto(`/course/${discussionCourse.id}/discussion`);
    await expect(page.getByText(/Question \d+ about the assignment/).first()).toBeVisible({ timeout: 60_000 });
    await waitForRecorderState(page, "recording");
    const results = await measure(page, 10, async (i) => {
      await page.mouse.wheel(0, i % 20 < 10 ? 500 : -500);
      await page.mouse.move(200 + ((i * 53) % 700), 150 + ((i * 37) % 400));
    });
    summary.discussion = results;
    console.log(`[bug-report redaction perf] discussion ${JSON.stringify(results)}`);
    for (const r of Object.values(results)) expect(r.worker).toBe(true);
  });
});
