/**
 * K3 (nightly tier): report dialog open to preview ready, no model, at most 5 s at p95 (hard
 * fail), on the instructor gradebook with 200 students and a 10-minute buffer, over
 * BUG_REPORT_K3_OPENS (default 20) opens.
 *
 * "Preview ready" is what `waitForReviewReady` waits for: the redaction pass has finished and
 * the player has rendered its first frame. Each open is timed two ways: wall clock in the test,
 * from the click on "Report a bug" until the page shows the preview ready (the budget), and in
 * the page, from the freeze at open to the first frame (`data-preview-ms`).
 *
 * The 10 minutes are recorded on a fake clock: every step scrolls the gradebook, moves the
 * pointer, and advances 5 s. Runs only with BUG_REPORT_NIGHTLY=1.
 */
/* eslint-disable no-console -- measurements printed for the run log */
import { test, expect } from "../../global-setup";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import {
  createAssignmentsAndGradebookColumns,
  createClass,
  createUsersInClass,
  loginAsUser,
  setCourseFeature,
  type TestingUser
} from "../TestingUtils";
import { captureTunnel } from "./tunnel";
import { replayReview, waitForReviewReady } from "./report";
import { recorderStats, setTestRoutePolicy, waitForRecorderState } from "./recorderTestUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

const MINUTES = Number(process.env.BUG_REPORT_K_MINUTES ?? 10);
const OPENS = Math.max(20, Number(process.env.BUG_REPORT_K3_OPENS ?? 20));
const BUDGET_MS = 5_000;

test.skip(process.env.BUG_REPORT_NIGHTLY !== "1", "nightly tier: set BUG_REPORT_NIGHTLY=1");

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

test.describe("K3: report dialog open to preview ready", () => {
  let course: Course;
  let instructor: TestingUser;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    course = await createClass({ name: "Bug Report K3 Gradebook" });
    [instructor] = await createUsersInClass([
      { role: "instructor", class_id: course.id, name: "K3 Gradebook Instructor", useMagicLink: true }
    ]);
    // In batches: createUsersInClass looks existing users up with one GET, whose URL gets too
    // long past a few dozen emails.
    for (let batch = 0; batch < 200; batch += 25) {
      await createUsersInClass(
        Array.from({ length: 25 }, (_, i) => ({
          role: "student" as const,
          class_id: course.id,
          name: `K3 Student ${String(batch + i).padStart(3, "0")}`
        }))
      );
    }
    await createAssignmentsAndGradebookColumns({ class_id: course.id, numAssignments: 5, numManualGradedColumns: 3 });
    await setCourseFeature(course.id, COURSE_FEATURES.BUG_REPORT_RECORDING, true);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([instructor]);
  });

  test(`K3: ${OPENS} opens on a ${MINUTES}-minute gradebook buffer, p95 <= 5 s`, async ({ page }, testInfo) => {
    test.setTimeout(30 * 60_000);
    await captureTunnel(page);
    await setTestRoutePolicy(page, [{ pattern: "/course/[course_id]/manage/gradebook", level: "structure" }]);
    await page.clock.install();
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/gradebook`);
    await expect(page.getByText("K3 Student 000").first()).toBeVisible({ timeout: 60_000 });
    await waitForRecorderState(page, "recording");

    const scroller = '[role="region"][aria-label="Instructor Gradebook Table"]';
    for (let i = 0; i < MINUTES * 12; i++) {
      await page.evaluate(
        ([sel, dir]) => {
          const el = document.querySelector(sel as string);
          if (el) el.scrollBy({ top: (dir as number) * 300, left: (dir as number) * 120 });
        },
        [scroller, i % 20 < 10 ? 1 : -1] as const
      );
      await page.mouse.move(200 + ((i * 53) % 700), 150 + ((i * 37) % 400));
      await page.clock.fastForward(5_000);
    }
    const stats = await recorderStats(page);
    console.log(`[bug-report K3] buffer ${JSON.stringify(stats)}`);
    expect(stats.segments).toBeGreaterThanOrEqual(MINUTES);

    const wall: number[] = [];
    const inPage: number[] = [];
    const events: number[] = [];
    for (let n = 0; n < OPENS; n++) {
      await page.getByRole("button", { name: "Support & Documentation" }).click();
      const started = Date.now();
      await page.getByRole("menuitem", { name: "Report a bug" }).click();
      const dialog = page.getByRole("dialog", { name: "Report a bug" });
      await waitForReviewReady(dialog, 30_000);
      wall.push(Date.now() - started);
      const review = replayReview(dialog);
      inPage.push(Number(await review.getAttribute("data-preview-ms")));
      events.push(Number(await review.getAttribute("data-event-count")));
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      // Some use between opens, so each open freezes a slightly different buffer.
      await page.mouse.move(100 + n * 10, 200);
      await page.clock.fastForward(1_000);
    }
    const w = [...wall].sort((a, b) => a - b);
    const p = [...inPage].sort((a, b) => a - b);
    const summary = {
      opens: OPENS,
      minutes: MINUTES,
      bufferChars: stats.size,
      segments: stats.segments,
      eventsInPreview: events[0],
      wallP50: percentile(w, 50),
      wallP95: percentile(w, 95),
      wallMax: w[w.length - 1],
      inPageP50: percentile(p, 50),
      inPageP95: percentile(p, 95)
    };
    console.log(
      `[bug-report K3] ${JSON.stringify(summary)} wall=${JSON.stringify(wall)} inPage=${JSON.stringify(inPage)}`
    );
    testInfo.annotations.push({ type: "K3", description: JSON.stringify(summary) });
    expect(summary.wallP95).toBeLessThanOrEqual(BUDGET_MS);
  });
});
