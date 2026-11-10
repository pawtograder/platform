/**
 * Package 6 measurements (run on demand, BUG_REPORT_NIGHTLY=1): compressed size and upload time
 * of 3- and 10-minute buffers recorded on the instructor gradebook with 200 students.
 *
 * Time on the page is a fake clock (`page.clock`): a scroll and a pointer move every 10 s, and
 * rrweb's checkout every 60 s. With the SENTRY_* variables set the upload goes through
 * /api/tunnel to the dev Sentry, so the upload time is real; without them captureTunnel answers
 * locally and the time is compression plus the local round trips.
 */
/* eslint-disable no-console -- measurements printed for the run log */
import { test, expect } from "../../global-setup";
import {
  createAssignmentsAndGradebookColumns,
  createClass,
  createUsersInClass,
  loginAsUser,
  setCourseFeature,
  type TestingUser
} from "../TestingUtils";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { captureTunnel, sentryApiFromEnv } from "./index";
import { setTestRoutePolicy, waitForRecorderState } from "./recorderTestUtils";
import { replaySegments, submitWithReplay } from "./uploadTestUtils";

test.skip(process.env.BUG_REPORT_NIGHTLY !== "1", "measurement: set BUG_REPORT_NIGHTLY=1");

const forward = sentryApiFromEnv() !== null;
const SCROLLER = '[role="region"][aria-label="Instructor Gradebook Table"]';

test.describe("replay upload size and time on the gradebook", () => {
  test.describe.configure({ mode: "serial" });
  let course: Awaited<ReturnType<typeof createClass>>;
  let instructor: TestingUser;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    course = await createClass({ name: "Bug Report Upload Measure" });
    [instructor] = await createUsersInClass([
      { role: "instructor", class_id: course.id, name: "Measure Instructor", useMagicLink: true }
    ]);
    // In batches: one call with 200 users makes a lookup URL too long for PostgREST.
    for (let b = 0; b < 200; b += 50) {
      await createUsersInClass(
        Array.from({ length: 50 }, (_, i) => ({
          role: "student" as const,
          class_id: course.id,
          name: `M Student ${String(b + i).padStart(3, "0")}`
        }))
      );
    }
    await createAssignmentsAndGradebookColumns({ class_id: course.id, numAssignments: 5, numManualGradedColumns: 3 });
    await setCourseFeature(course.id, COURSE_FEATURES.BUG_REPORT_RECORDING, true);
  });

  for (const minutes of [3, 10]) {
    test(`${minutes}-minute buffer`, async ({ page }, testInfo) => {
      test.setTimeout(900_000);
      await setTestRoutePolicy(page, [{ pattern: "/course/[course_id]/manage/gradebook", level: "structure" }]);
      await loginAsUser(page, instructor, course);
      await page.clock.install({ time: Date.now() - (minutes + 2) * 60_000 });
      const capture = await captureTunnel(page, { forward });
      await page.goto(`/course/${course.id}/manage/gradebook`);
      await expect(page.getByText("M Student 000").first()).toBeVisible({ timeout: 60_000 });
      await waitForRecorderState(page, "recording");
      for (let step = 0; step < minutes * 6; step++) {
        await page.mouse.move(200 + ((step * 53) % 700), 150 + ((step * 37) % 400));
        await page.evaluate(
          ([sel, dir]) => document.querySelector(sel as string)?.scrollBy({ top: (dir as number) * 300, left: 0 }),
          [SCROLLER, step % 20 < 10 ? 1 : -1] as const
        );
        await page.clock.fastForward(10_000);
      }
      await page.mouse.move(20, 20);
      const out = await submitWithReplay(
        page,
        { description: `measurement ${minutes} min` },
        { clock: true, timeout: 600_000 }
      );
      expect(out.result).toMatchObject({ status: "sent", replay: "attached" });
      const segments = replaySegments(capture);
      const compressed = out.stats!.compressedBytes.reduce((n, b) => n + b, 0);
      const result = {
        minutes,
        destination: forward ? "dev Sentry via /api/tunnel" : "local captureTunnel",
        windowSec: Math.round((out.buffer.endTimestamp - out.buffer.startTimestamp) / 1000),
        checkouts: out.buffer.checkouts,
        events: out.buffer.events,
        rawMiB: +(out.buffer.size / 1024 / 1024).toFixed(2),
        compressedKiB: Math.round(compressed / 1024),
        segments: segments.length,
        largestSegmentKiB: Math.round(Math.max(...out.stats!.compressedBytes) / 1024),
        compressMs: Math.round(out.stats!.compressMs),
        sendMs: Math.round(out.stats!.sendMs),
        submitToFeedbackMs: Math.round(out.totalMs)
      };
      console.log(`[bug-report upload measure] ${JSON.stringify(result)}`);
      await testInfo.attach(`upload-${minutes}min.json`, {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json"
      });
    });
  }
});
