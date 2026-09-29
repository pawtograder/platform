import { Course } from "@/utils/supabase/DatabaseTypes";
import type { Page } from "@playwright/test";
import { expect, test } from "../../global-setup";
import { assertReflowAt320, assertStudentPageAccessible, tabSequence } from "../axeStudentA11y";
import { createClass, createUsersInClass, loginAsUser, TestingUser } from "../TestingUtils";
import {
  assertNoReplayUploaded,
  captureTunnel,
  describeHits,
  payloadJsonOf,
  scanForCanaries,
  type CanaryRegistry,
  type CapturedEnvelope,
  type TunnelCapture
} from "./index";

/**
 * Package 5 (report dialog without replay): E5, E6, E7, E8, E9, E10, and the dialog half of A1.
 * The same tests with a replay attached (E1-E6) are in review.spec.ts.
 * PR tier: `captureTunnel` answers `/api/tunnel` itself, so nothing reaches Sentry.
 *
 * The build under test must have a valid Sentry DSN baked in (`NEXT_PUBLIC_SENTRY_DSN`, e.g.
 * `http://pawtogradere2e@127.0.0.1:54399/1`), or the SDK never sends and every submit fails with
 * "not configured". The browser SDK rejects a public key with a hyphen as an invalid DSN.
 */

type FeedbackEvent = {
  event_id: string;
  type: string;
  tags?: Record<string, string>;
  user?: Record<string, unknown>;
  contexts: { feedback: Record<string, unknown> };
};

const decoder = new TextDecoder();
const isFeedbackEnvelope = (e: CapturedEnvelope) => e.items.some((i) => i.header.type === "feedback");
const feedbackOf = (t: TunnelCapture) => t.items("feedback").map((i) => payloadJsonOf<FeedbackEvent>(i)!);
const errorEventsOf = (t: TunnelCapture) => t.items("event").map((i) => payloadJsonOf<{ event_id: string }>(i)!);

/** The shared check, plus: a report filed without a replay never names one. */
function assertNoReplayInReport(t: TunnelCapture) {
  assertNoReplayUploaded(t);
  for (const f of feedbackOf(t)) {
    expect(f.contexts.feedback).not.toHaveProperty("replay_id");
  }
}

let course: Course;
let student: TestingUser;

test.beforeAll(async () => {
  course = await createClass({ name: "E2E Bug Report Dialog" });
  [student] = await createUsersInClass([
    { role: "student", class_id: course.id, name: "Bugreport Student", useMagicLink: true }
  ]);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student]);
});

async function openFromUserMenu(page: Page) {
  await page.getByRole("button", { name: "Support & Documentation" }).click();
  await page.getByRole("menuitem", { name: "Report a bug" }).click();
  const dialog = page.getByRole("dialog", { name: "Report a bug" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Report a bug dialog (no replay)", () => {
  test("E7: the user menu entry opens the dialog instead of GitHub", async ({ page }) => {
    await loginAsUser(page, student, course);
    const popups: string[] = [];
    page.on("popup", (p) => popups.push(p.url()));
    const dialog = await openFromUserMenu(page);
    await expect(dialog.getByRole("textbox", { name: /What happened/ })).toBeFocused();
    expect(popups).toEqual([]);
  });

  test("A1 (dialog part) and cancel: no recorder, no replay section, feedback has no replay_id", async ({ page }) => {
    const rrwebRequests: string[] = [];
    page.on("request", (r) => {
      if (/rrweb/i.test(r.url())) rrwebRequests.push(r.url());
    });
    const tunnel = await captureTunnel(page);
    await loginAsUser(page, student, course);
    for (const path of ["assignments", "discussion", "office-hours", "regrade-requests"]) {
      await page.goto(`/course/${course.id}/${path}`);
      await expect(page.locator("#main-content")).toBeVisible();
    }
    await page.goto(`/course/${course.id}`);
    await expect(page.locator("#main-content")).toBeVisible();
    // An uncaught error, as a user would hit one.
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("E2E A1 thrown error");
      }, 0);
    });
    await expect.poll(() => errorEventsOf(tunnel).length).toBeGreaterThan(0);

    // Cancel sends nothing: type, cancel, then file a second report. Only the second arrives.
    let dialog = await openFromUserMenu(page);
    await dialog.getByRole("textbox", { name: /What happened/ }).fill("cancelled draft");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    dialog = await openFromUserMenu(page);
    await expect(dialog.getByRole("textbox", { name: /What happened/ })).toHaveValue("");
    await expect(dialog.getByTestId("report-bug-replay-section")).toHaveCount(0);
    await expect(dialog.getByTestId("report-bug-replay-notice")).toHaveCount(0);
    await dialog.getByRole("textbox", { name: /What happened/ }).fill("A1 report");
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();

    const feedback = feedbackOf(tunnel);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].contexts.feedback.message).toBe("A1 report");
    expect(feedback[0].contexts.feedback).not.toHaveProperty("replay_id");
    expect(feedback[0].tags).toMatchObject({
      class_id: String(course.id),
      role: "student",
      route: "/course/[course_id]",
      contact_ok: "false"
    });
    assertNoReplayInReport(tunnel);
    expect(rrwebRequests).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { __bugReportRecorder?: unknown }).__bugReportRecorder)
    ).toBe(undefined);
  });

  test("E10: contact_ok follows the checkbox, and no email is sent either way", async ({ page }) => {
    const tunnel = await captureTunnel(page);
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments`);

    let dialog = await openFromUserMenu(page);
    await dialog.getByRole("textbox", { name: /What happened/ }).fill("unchecked report");
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();

    dialog = await openFromUserMenu(page);
    await dialog.getByRole("textbox", { name: /What happened/ }).fill("checked report");
    await dialog.getByText("You may contact me about this").click();
    await expect(dialog.getByRole("checkbox", { name: "You may contact me about this" })).toBeChecked();
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();

    const feedback = feedbackOf(tunnel);
    expect(feedback.map((f) => [f.contexts.feedback.message, f.tags?.contact_ok])).toEqual([
      ["unchecked report", "false"],
      ["checked report", "true"]
    ]);
    for (const f of feedback) {
      expect(f.tags?.route).toBe("/course/[course_id]/assignments");
      expect(f.contexts.feedback.contact_email).toBeUndefined();
      expect(f.contexts.feedback.name).toBeUndefined();
      expect(f.user?.email).toBeUndefined();
    }
    for (const e of tunnel.envelopes.filter(isFeedbackEnvelope)) {
      const text = decoder.decode(e.raw);
      expect(text).not.toContain(student.email);
      expect(text).not.toContain(student.private_profile_name);
    }
  });

  test("E5: dialog passes axe, has the expected tab order, and reflows at 320px", async ({ page }) => {
    await loginAsUser(page, student, course);
    const dialog = await openFromUserMenu(page);
    await assertStudentPageAccessible(page, "report-bug dialog");

    // Focus is trapped in the dialog; Tab from the description walks the controls in order
    // and wraps. With a replay, the review controls go between the checkbox and Cancel
    // (review.spec.ts E5).
    const stops = await tabSequence(page, 5);
    const describe = (s: (typeof stops)[number]) => (s.tag === "textarea" ? "description" : s.text || s.tag);
    const names = stops.map(describe);
    const start = names.indexOf("description");
    expect(start, `tab stops: ${JSON.stringify(stops)}`).toBeGreaterThanOrEqual(0);
    const cycle = [...names.slice(start), ...names.slice(0, start)].slice(0, 4);
    const checkboxStop = stops[(start + 1) % stops.length];
    expect(checkboxStop.tag).toBe("input");
    expect(cycle[2]).toBe("Cancel");
    expect(cycle[3]).toBe("Submit");
    await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(1);

    // An open modal hides <main> from the accessibility tree, so measure the dialog instead.
    await assertReflowAt320(page, "report-bug dialog", { root: '[data-testid="report-bug-dialog"]' });
    await expect(dialog).toBeVisible();
  });

  test("E6: keyboard only, from the user menu to a sent report", async ({ page }) => {
    const tunnel = await captureTunnel(page);
    await loginAsUser(page, student, course);
    await page.getByRole("button", { name: "Support & Documentation" }).focus();
    await page.keyboard.press("Enter");
    const item = page.getByRole("menuitem", { name: "Report a bug" });
    await expect(item).toBeVisible();
    // Walk the menu with arrow keys until "Report a bug" is highlighted.
    for (let i = 0; i < 10; i++) {
      if ((await item.getAttribute("data-highlighted")) !== null) break;
      await page.keyboard.press("ArrowDown");
    }
    await expect(item).toHaveAttribute("data-highlighted", "");
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Report a bug" });
    await expect(dialog.getByRole("textbox", { name: /What happened/ })).toBeFocused();
    await page.keyboard.type("keyboard report");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Submit" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

    const feedback = feedbackOf(tunnel);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].contexts.feedback.message).toBe("keyboard report");
    expect(feedback[0].tags?.contact_ok).toBe("true");
  });

  test("the feedback carries none of the scope's unredacted data (breadcrumbs, extra, request)", async ({ page }) => {
    const canary = "Quillon Vandermeersch";
    const registry: CanaryRegistry = new Map([[canary, { kind: "name", column: "e2e.scope_canary", rowId: 1 }]]);
    const tunnel = await captureTunnel(page);
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments`);
    await expect(page.locator("#main-content")).toBeVisible();
    // A console message and a click on an element labelled with the canary: both become SDK
    // breadcrumbs on the scope.
    await page.evaluate((name) => {
      // eslint-disable-next-line no-console
      console.log("loaded profile", name);
      const button = document.createElement("button");
      button.setAttribute("aria-label", name);
      button.textContent = "x";
      button.id = "scope-canary-button";
      document.getElementById("main-content")!.appendChild(button);
    }, canary);
    await page.locator("#scope-canary-button").click();
    // Positive control: an error event sent now does carry those breadcrumbs.
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("E2E scope breadcrumb control");
      }, 0);
    });
    await expect.poll(() => errorEventsOf(tunnel).length).toBeGreaterThan(0);
    const errorItem = tunnel.items("event").at(-1)!;
    expect(scanForCanaries(decoder.decode(errorItem.payload), registry).length).toBeGreaterThan(0);

    const dialog = await openFromUserMenu(page);
    await dialog.getByRole("textbox", { name: /What happened/ }).fill("scope data report");
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();

    const [item] = tunnel.items("feedback");
    const feedback = payloadJsonOf<Record<string, unknown>>(item)!;
    expect(feedback).not.toHaveProperty("breadcrumbs");
    expect(feedback).not.toHaveProperty("extra");
    expect(feedback).not.toHaveProperty("request");
    expect(feedback.user).toEqual({ id: expect.any(String), ip_address: null });
    const hits = scanForCanaries(decoder.decode(item.payload), registry);
    expect(hits, describeHits(hits)).toEqual([]);
  });

  test("429: the dialog says try again later and keeps the draft", async ({ page }) => {
    await captureTunnel(page, { respond: (e) => (isFeedbackEnvelope(e) ? { status: 429, body: "" } : undefined) });
    await loginAsUser(page, student, course);
    const dialog = await openFromUserMenu(page);
    await dialog.getByRole("textbox", { name: /What happened/ }).fill("rate limited report");
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByTestId("report-bug-rate-limited")).toContainText("Try again later");
    await expect(dialog.getByRole("button", { name: "Submit" })).toBeFocused();
    await expect(dialog.getByRole("textbox", { name: /What happened/ })).toHaveValue("rate limited report");
  });

  test("E8: a failed request's error toast offers Report this, prefilled with the event ID", async ({ page }) => {
    const tunnel = await captureTunnel(page);
    await loginAsUser(page, student, course);
    await page.route(
      (url) => url.pathname.endsWith("/rest/v1/submission_regrade_requests"),
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ code: "XX000", message: "E2E forced failure", details: null, hint: null })
        })
    );
    await page.goto(`/course/${course.id}/regrade-requests`);
    // The visual-test stylesheet hides the toaster (`data-visual-test="removed"`); this test
    // needs to click in it.
    await page.evaluate(() => document.documentElement.removeAttribute("data-visual-tests"));

    const toast = page.getByRole("status").filter({ hasText: "Error loading regrade requests" });
    await expect(toast).toBeVisible();
    await expect.poll(() => errorEventsOf(tunnel).length).toBeGreaterThan(0);
    const errorEventId = errorEventsOf(tunnel).at(-1)!.event_id;

    await toast.getByRole("button", { name: "Report this" }).click();
    const dialog = page.getByRole("dialog", { name: "Report a bug" });
    await expect(dialog.getByTestId("report-bug-event-id")).toHaveText(errorEventId);

    await dialog.getByRole("textbox", { name: /What happened/ }).fill("regrade list failed");
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();
    // The toast is gone, so focus returns to the main landmark, not <body>.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName))
      .toBe("main-content");
    const [feedback] = feedbackOf(tunnel);
    expect(feedback.contexts.feedback.associated_event_id).toBe(errorEventId);
    expect(feedback.tags?.linked_event_id).toBe(errorEventId);
    expect(feedback.tags?.route).toBe("/course/[course_id]/regrade-requests");
    assertNoReplayInReport(tunnel);
  });

  test("E9: a render crash shows the plain global-error form, which files feedback with the error ID", async ({
    page
  }) => {
    const tunnel = await captureTunnel(page);
    await loginAsUser(page, student, course);
    await page.goto("/e2e/render-crash");
    const form = page.getByTestId("global-error-report-form");
    await expect(form).toBeVisible();
    const errorId = (await form.getByTestId("global-error-event-id").textContent())!.trim();
    expect(errorId).toMatch(/^[0-9a-f]{32}$/);
    await expect.poll(() => errorEventsOf(tunnel).map((e) => e.event_id)).toContain(errorId);

    await form.getByLabel("What happened?").fill("page crashed");
    await form.getByLabel("You may contact me about this").check();
    await form.getByRole("button", { name: "Send report" }).click();
    await expect(page.getByText("Thanks, your report was sent.")).toBeVisible();

    const [feedback] = feedbackOf(tunnel);
    expect(feedback.contexts.feedback.message).toBe("page crashed");
    expect(feedback.contexts.feedback.associated_event_id).toBe(errorId);
    expect(feedback.tags).toMatchObject({ linked_event_id: errorId, contact_ok: "true", route: "/e2e/render-crash" });
    expect(feedback.tags).not.toHaveProperty("class_id");
    assertNoReplayInReport(tunnel);
  });
});
