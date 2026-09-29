/**
 * Package 1 gating tests (PR tier): A1, A2, A4, A6, with the report dialog halves of A1 and A6
 * (package 5b).
 *
 * Needs a build made with E2E_ENABLE=true (so the test route policy is honored). No Sentry.
 */
/* eslint-disable no-console -- page-side console calls are what the tests record, or measurements printed for the run log */
import { test, expect } from "../../global-setup";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { createClass, createUsersInClass, loginAsUser, setCourseFeature, type TestingUser } from "../TestingUtils";
import {
  allEvents,
  allSerializedNodes,
  clickNavLink,
  collectScripts,
  enableRecording,
  freeze,
  isMasked,
  recordedTexts,
  recorderChunkRequested,
  recorderDefined,
  setTestRoutePolicy,
  waitForRecorderState
} from "./recorderTestUtils";
import { assertNoReplayUploaded, captureTunnel, payloadJsonOf } from "./tunnel";
import { openReportDialog } from "./report";

type FeedbackPayload = { contexts?: { feedback?: Record<string, unknown> } };

type Course = Awaited<ReturnType<typeof createClass>>;

test.describe("bug report recorder gating", () => {
  let offCourse: Course;
  let onCourse: Course;
  let offStudent: TestingUser;
  let onStudent: TestingUser;
  let onInstructor: TestingUser;
  const gradebookNames = ["Zebulon Quixotic", "Wilhelmina Farthingale", "Ignatius Blatherwick"];

  test.beforeAll(async () => {
    offCourse = await createClass({ name: "Bug Report Off Course" });
    onCourse = await createClass({ name: "Bug Report On Course" });
    [offStudent] = await createUsersInClass([
      { role: "student", class_id: offCourse.id, name: "Recorder Off Student", useMagicLink: true }
    ]);
    [onStudent, onInstructor] = await createUsersInClass([
      { role: "student", class_id: onCourse.id, name: gradebookNames[0], useMagicLink: true },
      { role: "instructor", class_id: onCourse.id, name: "Recorder On Instructor", useMagicLink: true },
      { role: "student", class_id: onCourse.id, name: gradebookNames[1], useMagicLink: true },
      { role: "student", class_id: onCourse.id, name: gradebookNames[2], useMagicLink: true }
    ]);
    await setCourseFeature(onCourse.id, COURSE_FEATURES.BUG_REPORT_RECORDING, true);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([offStudent, onStudent, onInstructor]);
  });

  test("A1: with the flag off, the recorder chunk is never requested", async ({ page }) => {
    const scripts = collectScripts(page);
    await loginAsUser(page, offStudent, offCourse);
    // Five pages, listed and unlisted, by full load and by client navigation.
    await page.goto(`/course/${offCourse.id}/discussion`);
    await clickNavLink(page, `/course/${offCourse.id}/office-hours`);
    await clickNavLink(page, `/course/${offCourse.id}/gradebook`);
    await clickNavLink(page, `/course/${offCourse.id}/assignments`);
    await page.goto(`/course/${offCourse.id}/polls`);
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("A1 synthetic error");
      }, 0);
    });
    await page.waitForLoadState("networkidle");

    expect(await recorderDefined(page)).toBe(false);
    expect(scripts.urls.length).toBeGreaterThan(0);
    expect(await recorderChunkRequested(scripts)).toBe(false);
  });

  test("A1 (dialog): with the flag off, a report has no replay section and no replay_id", async ({ page }) => {
    const scripts = collectScripts(page);
    const capture = await captureTunnel(page);
    await loginAsUser(page, offStudent, offCourse);
    await page.goto(`/course/${offCourse.id}/discussion`);
    await clickNavLink(page, `/course/${offCourse.id}/gradebook`);
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("A1 dialog synthetic error");
      }, 0);
    });
    await expect.poll(() => capture.items("event").length).toBeGreaterThan(0);

    const dialog = await openReportDialog(page);
    await expect(dialog.getByTestId("report-bug-replay-section")).toHaveCount(0);
    await expect(dialog.getByTestId("report-bug-replay-notice")).toHaveCount(0);
    await dialog.getByRole("textbox", { name: /What happened/ }).fill("A1 flag off report");
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();

    const feedback = capture.items("feedback").map((i) => payloadJsonOf<FeedbackPayload>(i)!);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].contexts?.feedback).not.toHaveProperty("replay_id");
    assertNoReplayUploaded(capture);
    expect(await recorderDefined(page)).toBe(false);
    // Neither the recorder nor the player (both rrweb) loaded for the report.
    expect(await recorderChunkRequested(scripts)).toBe(false);
  });

  test("A2: not recording on an unlisted route; the buffer has no events from one", async ({ page }) => {
    const scripts = collectScripts(page);
    await loginAsUser(page, onInstructor, onCourse);
    const unlisted = `/course/${onCourse.id}/manage/course/lti`;
    await page.goto(unlisted);
    await page.waitForLoadState("networkidle");
    expect(await recorderDefined(page)).toBe(false);
    // Positive control for A1: the marker check does find the chunk once recording starts.
    expect(await recorderChunkRequested(scripts)).toBe(false);

    await clickNavLink(page, `/course/${onCourse.id}/discussion`);
    await waitForRecorderState(page, "recording");
    expect(await recorderChunkRequested(scripts)).toBe(true);
    const replayId = await page.evaluate(() => window.__bugReportRecorder!.getReplayId());

    // Back to an unlisted route by client navigation: recording pauses.
    await clickNavLink(page, `/course/${onCourse.id}/manage/assignments`);
    await waitForRecorderState(page, "paused");
    const pausedFrom = await page.evaluate(() => Date.now());
    // Activity on the unlisted page that would otherwise be recorded.
    await page.mouse.move(200, 200);
    await page.mouse.move(300, 250);
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.textContent = "unlisted route activity";
      document.body.appendChild(d);
      console.log("unlisted route console");
    });
    const pausedUntil = await page.evaluate(() => Date.now());

    await clickNavLink(page, `/course/${onCourse.id}/discussion`);
    await waitForRecorderState(page, "recording");
    const buffer = await freeze(page);
    expect(buffer.replayId).toBe(replayId);
    expect(buffer.segments.length).toBeGreaterThanOrEqual(2);

    const events = allEvents(buffer);
    const during = events.filter((e) => e.timestamp > pausedFrom && e.timestamp < pausedUntil);
    expect(during).toEqual([]);
    // (Nav links to the unlisted routes are part of every page, so look at where the recording
    // was, not at every string in it.)
    const metaPaths = events
      .filter((e) => e.type === 4)
      .map((e) => new URL((e.data as { href: string }).href).pathname);
    expect(new Set(metaPaths)).toEqual(new Set([`/course/${onCourse.id}/discussion`]));
    expect(JSON.stringify(buffer)).not.toContain("unlisted route console");
    for (const seg of buffer.segments) {
      expect(seg.events[0].type).toBe(4);
      expect(seg.events[1].type).toBe(2);
    }
    expect(buffer.urls.every((u) => new URL(u).pathname === `/course/${onCourse.id}/discussion`)).toBe(true);
  });

  test("A4: gradebook at level structure records no real text, keeps table structure", async ({ page }) => {
    await enableRecording(page, onCourse.id, [{ pattern: "/course/[course_id]/manage/gradebook", level: "structure" }]);
    await loginAsUser(page, onInstructor, onCourse);
    await page.goto(`/course/${onCourse.id}/manage/gradebook`);
    await waitForRecorderState(page, "recording");
    await expect(page.getByText(gradebookNames[1]).first()).toBeVisible();
    // The name's text node reaches the buffer (masked, same shape) once rrweb flushes mutations.
    const maskedName = gradebookNames[1].replace(/\S/g, "*");
    await expect.poll(async () => recordedTexts(await freeze(page)).some((t) => t.includes(maskedName))).toBe(true);

    const buffer = await freeze(page);
    expect(buffer.level).toBe("structure");
    const texts = recordedTexts(buffer).filter((t) => t.trim().length > 0);
    expect(texts.length).toBeGreaterThan(20);
    expect(texts.filter((t) => !isMasked(t))).toEqual([]);

    const json = JSON.stringify(buffer);
    for (const name of [...gradebookNames, "Recorder On Instructor", ...gradebookNames.map((n) => n.split(" ")[1])]) {
      expect(json).not.toContain(name);
    }
    const tags = new Set(allSerializedNodes(buffer).map((n) => n.tagName));
    expect(tags.has("table") || tags.has("tbody")).toBe(true);
    expect(tags.has("tr") || tags.has("td")).toBe(true);
  });

  test("A6: turning the flag off stops the recorder on the next navigation", async ({ page }) => {
    const course = await createClass({ name: "Bug Report Flag Flip Course" });
    const [student] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Flag Flip Student", useMagicLink: true }
    ]);
    await enableRecording(page, course.id);
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/discussion`);
    await waitForRecorderState(page, "recording");
    expect((await freeze(page)).segments.length).toBeGreaterThan(0);
    // Keep a handle on the instance to check it discarded its buffer, not just unpublished it.
    await page.evaluate(() => {
      (window as unknown as { __a6Recorder: unknown }).__a6Recorder = window.__bugReportRecorder;
    });

    await setCourseFeature(course.id, COURSE_FEATURES.BUG_REPORT_RECORDING, false);
    await clickNavLink(page, `/course/${course.id}/office-hours`);
    await page.waitForFunction(() => window.__bugReportRecorder === undefined);
    const after = await page.evaluate(() => {
      const r = (window as unknown as { __a6Recorder: { getState(): string; freeze(): { segments: unknown[] } } })
        .__a6Recorder;
      return { state: r.getState(), segments: r.freeze().segments.length };
    });
    expect(after).toEqual({ state: "stopped", segments: 0 });

    // And it stays off on later listed routes.
    await clickNavLink(page, `/course/${course.id}/gradebook`);
    await page.waitForLoadState("networkidle");
    expect(await recorderDefined(page)).toBe(false);
  });

  test("A6 (dialog): a report after the flag is turned off has no replay", async ({ page }) => {
    const course = await createClass({ name: "Bug Report Flag Flip Report Course" });
    const [student] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Flag Flip Reporter", useMagicLink: true }
    ]);
    const capture = await captureTunnel(page);
    await enableRecording(page, course.id);
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/discussion`);
    await waitForRecorderState(page, "recording");
    // Positive control: while recording, the dialog has the review.
    let dialog = await openReportDialog(page);
    await expect(dialog.getByTestId("report-bug-replay-section")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await setCourseFeature(course.id, COURSE_FEATURES.BUG_REPORT_RECORDING, false);
    await clickNavLink(page, `/course/${course.id}/office-hours`);
    await page.waitForFunction(() => window.__bugReportRecorder === undefined);

    dialog = await openReportDialog(page);
    await expect(dialog.getByTestId("report-bug-replay-section")).toHaveCount(0);
    await expect(dialog.getByTestId("report-bug-replay-notice")).toHaveCount(0);
    await dialog.getByRole("textbox", { name: /What happened/ }).fill("A6 report after flag off");
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();
    const feedback = capture.items("feedback").map((i) => payloadJsonOf<FeedbackPayload>(i)!);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].contexts?.feedback).not.toHaveProperty("replay_id");
    assertNoReplayUploaded(capture);
  });

  test("recording starts after a client navigation from an unlisted route to a listed one", async ({ page }) => {
    await setTestRoutePolicy(page, []);
    await loginAsUser(page, onStudent, onCourse);
    await page.goto(`/course/${onCourse.id}/flashcards`);
    await page.waitForLoadState("networkidle");
    expect(await recorderDefined(page)).toBe(false);
    await clickNavLink(page, `/course/${onCourse.id}/gradebook`);
    await waitForRecorderState(page, "recording");
    expect(await page.evaluate(() => window.__bugReportRecorder!.getLevel())).toBe("full");
  });
});
