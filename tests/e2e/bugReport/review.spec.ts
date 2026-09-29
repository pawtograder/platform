/**
 * Package 5b (the report dialog's replay review), PR tier: E1-E6 with a recording attached.
 * `captureTunnel` answers /api/tunnel itself, so nothing reaches Sentry.
 *
 * Needs a build made with E2E_ENABLE=true (the harness page and the test route policy) and a
 * NEXT_PUBLIC_SENTRY_DSN the browser SDK accepts (e.g. `http://pawtogradere2e@127.0.0.1:54399/1`).
 */
/* eslint-disable no-console -- measurements printed for the run log */
import type { Page } from "@playwright/test";
import { test, expect } from "../../global-setup";
import { assertReflowAt320, assertStudentPageAccessible, tabSequence } from "../axeStudentA11y";
import { createClass, createUsersInClass, loginAsUser, type TestingUser } from "../TestingUtils";
import type { RoutePolicyEntry } from "@/lib/bugReport/routePolicy";
import { captureTunnel, describeHits, scanForCanaries, type CanaryRegistry } from "./index";
import {
  openReportDialog,
  previewText,
  redactInReview,
  remainingStrings,
  replayReview,
  submitReportAndCapture,
  waitForReviewReady
} from "./report";
import { enableRecording, waitForRecorderState } from "./recorderTestUtils";
import { feedbackEnvelopes, recordMinutes, replaySegments } from "./uploadTestUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

const HARNESS: RoutePolicyEntry = { pattern: "/course/[course_id]/e2e-harness/bug-report", level: "full" };

/** Synthetic values the `leaks` fixture renders unmasked, and puts in its taint block. */
const LEAK = {
  name: "Prudencia Vantongeren",
  otherName: "Ottoline Brackenbury",
  email: "zq.review.canary@example.edu",
  handle: "zqreviewhandle"
};
const REGISTRY: CanaryRegistry = new Map([
  [LEAK.name, { kind: "name", column: "e2e.leak_fixture", rowId: 1 }],
  [LEAK.otherName, { kind: "name", column: "e2e.leak_fixture", rowId: 2 }],
  [LEAK.email, { kind: "email", column: "e2e.leak_fixture", rowId: 1 }],
  [LEAK.handle, { kind: "handle", column: "e2e.leak_fixture", rowId: 1 }]
]);

const decoder = new TextDecoder();
const uploadText = (bytes: Uint8Array[]) => bytes.map((b) => decoder.decode(b)).join("\n");

let course: Course;
let student: TestingUser;

test.beforeAll(async () => {
  course = await createClass({ name: "E2E Bug Report Review" });
  [student] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Review Student", useMagicLink: true }
  ]);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student]);
});

async function openHarness(page: Page, fixture: "leaks" | "inputs" = "leaks") {
  await enableRecording(page, course.id, [HARNESS]);
  await loginAsUser(page, student, course);
  const query = fixture === "leaks" ? `fixture=leaks&v=${encodeURIComponent(JSON.stringify(LEAK))}` : "fixture=inputs";
  await page.goto(`/course/${course.id}/e2e-harness/bug-report?${query}`);
  await waitForRecorderState(page, "recording");
  if (fixture === "leaks") await expect(page.getByTestId("leak-fixture")).toBeVisible();
}

test.describe("Report a bug dialog, replay review", () => {
  test("E1: after 3 minutes of recording, the preview renders its first frame", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.clock.install();
    const capture = await captureTunnel(page);
    await openHarness(page, "inputs");
    await recordMinutes(page, 3);

    const started = Date.now();
    const dialog = await openReportDialog(page);
    await expect(dialog.getByTestId("report-bug-replay-notice")).toHaveText(
      "This report includes a redacted recording of your last few minutes on this page"
    );
    await waitForReviewReady(dialog);
    const wallMs = Date.now() - started;
    const review = replayReview(dialog);
    const events = Number(await review.getAttribute("data-event-count"));
    const previewMs = Number(await review.getAttribute("data-preview-ms"));
    expect(events).toBeGreaterThan(0);
    // The first frame is the rebuilt page: the harness heading's text node is there (masked).
    await expect.poll(async () => (await previewText(dialog))?.includes("*******")).toBe(true);
    const frame = await dialog.getByTestId("report-bug-replay-player").evaluate((el) => {
      const iframe = el.querySelector("iframe")!;
      return {
        sandbox: iframe.getAttribute("sandbox"),
        title: iframe.getAttribute("title"),
        nodes: iframe.contentDocument?.querySelectorAll("*").length ?? 0
      };
    });
    expect(frame.sandbox).toBe("allow-same-origin");
    expect(frame.title).toBe("Redacted recording preview");
    expect(frame.nodes).toBeGreaterThan(10);
    console.log(`[bug-report E1] events=${events} previewReadyMs(in page)=${previewMs} wallMs=${wallMs}`);
    testInfo.annotations.push({ type: "E1 preview ready", description: `${previewMs} ms in page, ${wallMs} ms wall` });
    // Opening the review sent nothing.
    expect(capture.items("replay_recording")).toHaveLength(0);
    expect(capture.items("feedback")).toHaveLength(0);
  });

  test("E2: the remaining strings are a list grouped by type, with no canary", async ({ page }) => {
    await captureTunnel(page);
    await openHarness(page);
    const dialog = await openReportDialog(page);
    await waitForReviewReady(dialog);

    const remaining = dialog.getByTestId("report-bug-remaining");
    const groups = remaining.locator("section[data-kind]");
    const kinds = await groups.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
    expect(kinds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toContain("text");
    // Each group is a labelled region with a heading and a real list.
    for (const kind of kinds) {
      const group = remaining.locator(`section[data-kind="${kind}"]`);
      await expect(group.getByRole("heading", { level: 4 })).toBeVisible();
      await expect(group.getByRole("list")).toHaveCount(1);
      expect(await group.getByRole("listitem").count()).toBeGreaterThan(0);
    }
    const strings = await remainingStrings(dialog);
    expect(strings.map((s) => s.value)).toContain("Email the student");
    const hits = scanForCanaries(JSON.stringify(strings), REGISTRY);
    expect(hits, describeHits(hits)).toEqual([]);
    // The player's accessible name points at the list as its text alternative.
    const player = dialog.getByTestId("report-bug-replay-player");
    await expect(player).toHaveAttribute("role", "img");
    await expect(player).toHaveAccessibleDescription(/Text in the recording/);
  });

  test("E3: a redacted string is gone from the preview, the list, and the upload", async ({ page }) => {
    const capture = await captureTunnel(page);
    await openHarness(page);
    const target = "Email the student";
    const dialog = await openReportDialog(page);
    await waitForReviewReady(dialog);
    await expect.poll(async () => (await previewText(dialog)) ?? "").toContain(target);

    await redactInReview(dialog, target);
    await expect.poll(async () => (await previewText(dialog)) ?? "", { timeout: 20_000 }).not.toContain(target);
    await expect.poll(async () => (await previewText(dialog)) ?? "").toContain("*".repeat(target.length));

    await dialog.getByRole("textbox", { name: /What happened/ }).fill("E3 report");
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible({ timeout: 60_000 });
    const segments = replaySegments(capture);
    expect(segments.length).toBeGreaterThan(0);
    const [feedback] = feedbackEnvelopes(capture);
    expect(feedback.event.contexts?.feedback?.replay_id).toBe(segments[0].event.replay_id);
    const text = uploadText(capture.uploadedBytes());
    expect(text).toContain("Profile link");
    expect(text).not.toContain(target);
  });

  test("E4: keep the last 2 minutes uploads at most 2 minutes, starting with a checkout", async ({ page }) => {
    test.setTimeout(180_000);
    await page.clock.install();
    const capture = await captureTunnel(page);
    await openHarness(page, "inputs");
    await recordMinutes(page, 4);

    const bytes = await submitReportAndCapture(page, capture, { description: "E4 report", keepLastMinutes: 2 });
    expect(bytes.length).toBeGreaterThan(0);
    const segments = replaySegments(capture);
    expect(segments.length).toBeGreaterThan(0);
    const events = segments
      .sort((a, b) => a.event.segment_id - b.event.segment_id)
      .flatMap((s) => (s.recording.recordingEvents ?? []) as { type: number; timestamp: number }[]);
    expect(events[0].type).toBe(4);
    expect(events[1].type).toBe(2);
    const span = events[events.length - 1].timestamp - events[0].timestamp;
    console.log(`[bug-report E4] uploaded span ${span} ms over ${events.length} events`);
    expect(span).toBeLessThanOrEqual(2 * 60_000);
    // Positive control: the buffer itself was longer than that.
    const full = await page.evaluate(() => {
      const b = window.__bugReportRecorder!.freeze();
      return b.endTimestamp - b.startTimestamp;
    });
    expect(full).toBeGreaterThan(3 * 60_000);
  });

  test("E5: the dialog with a replay passes axe, has the expected tab order, and reflows at 320px", async ({
    page
  }) => {
    await captureTunnel(page);
    await openHarness(page);
    const dialog = await openReportDialog(page);
    await waitForReviewReady(dialog);
    await assertStudentPageAccessible(page, "report-bug dialog with replay");

    const redactCount = await dialog.locator("button[data-redact]").count();
    expect(redactCount).toBeGreaterThan(0);
    const cycle = redactCount + 6;
    const stops = await tabSequence(page, cycle + 1);
    const describe = (s: (typeof stops)[number]) => {
      if (s.tag === "textarea") return "description";
      if (s.tag === "input") return "contact";
      if (s.tag === "select") return "minutes";
      if (s.ariaLabel?.startsWith("Redact ")) return "redact";
      return s.text || s.tag;
    };
    const names = stops.map(describe);
    const start = names.indexOf("description");
    expect(start, `tab stops: ${JSON.stringify(stops)}`).toBeGreaterThanOrEqual(0);
    const order = [...names.slice(start), ...names.slice(0, start)].slice(0, cycle);
    expect(order).toEqual([
      "description",
      "contact",
      "Play preview",
      ...Array.from({ length: redactCount }, () => "redact"),
      "minutes",
      "Cancel",
      "Submit"
    ]);
    // The focus trap wraps: one more Tab lands back on the stop the cycle started from.
    expect(names[cycle]).toBe(names[0]);

    await assertReflowAt320(page, "report-bug dialog with replay", { root: '[data-testid="report-bug-dialog"]' });
    const box = await dialog.getByTestId("report-bug-replay-player").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(320);
    await expect(dialog).toBeVisible();
  });

  test("E6: keyboard only, from the user menu through a redaction to a sent report", async ({ page }) => {
    const capture = await captureTunnel(page);
    await openHarness(page);
    await page.getByRole("button", { name: "Support & Documentation" }).focus();
    await page.keyboard.press("Enter");
    const item = page.getByRole("menuitem", { name: "Report a bug" });
    await expect(item).toBeVisible();
    for (let i = 0; i < 10; i++) {
      if ((await item.getAttribute("data-highlighted")) !== null) break;
      await page.keyboard.press("ArrowDown");
    }
    await expect(item).toHaveAttribute("data-highlighted", "");
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Report a bug" });
    await expect(dialog.getByRole("textbox", { name: /What happened/ })).toBeFocused();
    await page.keyboard.type("keyboard replay report");
    await waitForReviewReady(dialog);

    const target = "Profile link";
    const redactButton = dialog.getByRole("button", { name: `Redact "${target}"` });
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await redactButton.evaluate((el) => el === document.activeElement).catch(() => false);
    }
    expect(reached, "Tab reaches the Redact button").toBe(true);
    await page.keyboard.press("Enter");
    await waitForReviewReady(dialog);
    expect((await remainingStrings(dialog)).map((s) => s.value)).not.toContain(target);
    // Focus stays in the list, on the next string's button, not on <body>.
    expect(
      await page.evaluate(() => document.activeElement?.closest("[data-testid='report-bug-remaining']") !== null)
    ).toBe(true);

    const submit = dialog.getByRole("button", { name: "Submit" });
    reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await submit.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "Tab reaches Submit").toBe(true);
    await page.keyboard.press("Enter");
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

    const [feedback] = feedbackEnvelopes(capture);
    expect(feedback.event.contexts?.feedback?.message).toBe("keyboard replay report");
    expect(replaySegments(capture).length).toBeGreaterThan(0);
    const text = uploadText(capture.uploadedBytes());
    expect(text).toContain("Email the student");
    expect(text).not.toContain(target);
  });

  test("the preview requests no page assets from other origins and sends nothing", async ({ page, baseURL }) => {
    const capture = await captureTunnel(page);
    await openHarness(page);
    const origin = new URL(baseURL!).origin;
    const during: { url: string; method: string; hasBody: boolean }[] = [];
    page.on("request", (r) => during.push({ url: r.url(), method: r.method(), hasBody: r.postDataBuffer() !== null }));
    const dialog = await openReportDialog(page);
    await waitForReviewReady(dialog);
    await dialog.getByTestId("report-bug-replay-play").click();
    await expect(dialog.getByTestId("report-bug-replay-play")).toHaveText(/Pause preview/);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    const offOrigin = during.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith("data:"));
    // Supabase (auth refresh, realtime) is the app's own traffic, not the player's.
    const supabase = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : "";
    expect(offOrigin.filter((r) => !supabase || !r.url.startsWith(supabase))).toEqual([]);
    expect(during.filter((r) => r.url.includes("/api/tunnel"))).toEqual([]);
    expect(capture.items("replay_recording")).toHaveLength(0);
  });

  test("a failed redaction leaves the replay out, and the report still sends", async ({ page }) => {
    const capture = await captureTunnel(page);
    // The redaction worker can't start. (Other workers, such as Realtime's, still can.)
    await page.addInitScript(() => {
      const Native = window.Worker;
      window.Worker = class extends Native {
        constructor(url: string | URL, options?: WorkerOptions) {
          if (options?.name === "bug-report-redaction") throw new Error("E2E: redaction worker blocked");
          super(url, options);
        }
      };
    });
    await openHarness(page);
    const dialog = await openReportDialog(page);
    await expect(dialog.getByTestId("report-bug-replay-error")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId("report-bug-replay-notice")).toHaveCount(0);
    await dialog.getByRole("textbox", { name: /What happened/ }).fill("report without replay");
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();
    expect(replaySegments(capture)).toHaveLength(0);
    const [feedback] = feedbackEnvelopes(capture);
    expect(feedback.event.contexts?.feedback?.replay_id).toBeUndefined();
    expect(feedback.event.tags?.replay_upload).toBeUndefined();
  });
});
