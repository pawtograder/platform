/**
 * Package 2 measurement: taint ingest overhead on the instructor gradebook (200 students).
 *
 * Reports the main-thread time spent classifying and adding to the taint set during one page
 * load, the time spent reading and parsing cloned response bodies, and the taint set's size.
 * Runs only with BUG_REPORT_MEASURE=1 (it seeds 200 students). Needs an E2E_ENABLE=true build.
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
import { setTestRoutePolicy, waitForRecorderState } from "./recorderTestUtils";

test.skip(process.env.BUG_REPORT_MEASURE !== "1", "measurement: set BUG_REPORT_MEASURE=1");

test.describe("taint ingest overhead", () => {
  test.describe.configure({ mode: "serial" });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    course = await createClass({ name: "Bug Report Ingest Gradebook" });
    const users = await createUsersInClass([
      { role: "instructor", class_id: course.id, name: "Ingest Gradebook Instructor", useMagicLink: true },
      ...Array.from({ length: 200 }, (_, i) => ({
        role: "student" as const,
        class_id: course.id,
        name: `Ingest Student ${String(i).padStart(3, "0")}`
      }))
    ]);
    instructor = users[0];
    await createAssignmentsAndGradebookColumns({ class_id: course.id, numAssignments: 5, numManualGradedColumns: 3 });
    await setCourseFeature(course.id, COURSE_FEATURES.BUG_REPORT_RECORDING, true);
  });

  for (let run = 1; run <= 3; run++) {
    test(`gradebook page load ${run}`, async ({ page }) => {
      await setTestRoutePolicy(page, [{ pattern: "/course/[course_id]/manage/gradebook", level: "structure" }]);
      await loginAsUser(page, instructor, course);
      await page.goto(`/course/${course.id}/manage/gradebook`);
      await expect(page.getByText("Ingest Student 000").first()).toBeVisible({ timeout: 60_000 });
      await waitForRecorderState(page, "recording");
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.evaluate(() => window.__bugReportTaint!.idle());
      const stats = await page.evaluate(() => window.__bugReportTaint!.stats());
      const heap = await page.evaluate(
        () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null
      );
      console.log(`[bug-report ingest measure] ${JSON.stringify({ run, ...stats, usedJSHeapSize: heap })}`);
      expect(await page.evaluate(() => window.__bugReportTaint!.has("Ingest Student 199"))).toBe(true);
    });
  }
});
