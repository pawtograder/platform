/**
 * Package 1 "nothing leaves before submit" tests (PR tier): B1-B4.
 *
 * Needs a build made with E2E_ENABLE=true and a NEXT_PUBLIC_SENTRY_DSN (any; CI uses
 * STUB_SENTRY_DSN), so the browser SDK sends envelopes to /api/tunnel. `captureTunnel` answers
 * them locally; nothing leaves the machine.
 *
 * B2 and B3 open the review dialog, which package 5 builds. Until it exists they stand in for
 * "open the dialog" with `freeze()`, the only recorder call the dialog makes before submit.
 */
import { test, expect } from "../../global-setup";
import type { Page } from "@playwright/test";
import { createClass, createUsersInClass, loginAsUser, type TestingUser } from "../TestingUtils";
import { assertNoReplayUploaded, captureTunnel, payloadJsonOf, type CapturedEnvelope } from "./index";
import { clickNavLink, enableRecording, freeze, recorderStats, waitForRecorderState } from "./recorderTestUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

type ErrorPayload = {
  event_id?: string;
  type?: string;
  exception?: { values?: { value?: string }[] };
  contexts?: Record<string, unknown> & { trace?: { trace_id?: string } };
};

function errorEventOf(envelope: CapturedEnvelope): ErrorPayload | undefined {
  const item = envelope.items.find((i) => i.header.type === "event");
  return item ? payloadJsonOf<ErrorPayload>(item) : undefined;
}

function mentions(envelope: CapturedEnvelope, text: string): boolean {
  return new TextDecoder().decode(envelope.raw).includes(text);
}

/** The browser SDK's client, from the global carrier (tests only; the app exposes nothing). */
async function sentryCall(page: Page, what: "flush" | "close" | "feedback"): Promise<unknown> {
  return page.evaluate(async (w) => {
    type Client = { flush(t?: number): Promise<boolean>; close(t?: number): Promise<boolean> };
    type Scope = { getClient(): Client | undefined; captureEvent(e: unknown): string };
    const carrier = (window as unknown as { __SENTRY__?: Record<string, unknown> & { version?: string } }).__SENTRY__;
    const v = carrier?.version ? (carrier[carrier.version] as Record<string, unknown>) : undefined;
    const scope =
      (v?.stack as { getScope?: () => Scope } | undefined)?.getScope?.() ?? (v?.defaultCurrentScope as Scope);
    const client = scope?.getClient();
    if (!client) throw new Error("no Sentry client");
    if (w === "flush") return client.flush(2000);
    if (w === "close") return client.close(2000);
    // What Sentry.sendFeedback does without the feedback integration: a feedback event.
    return scope.captureEvent({
      type: "feedback",
      level: "info",
      contexts: { feedback: { message: "B4 direct feedback" } }
    });
  }, what);
}

test.describe("bug report recorder uploads nothing before submit", () => {
  let course: Course;
  let student: TestingUser;

  test.beforeAll(async () => {
    course = await createClass({ name: "Bug Report No Upload Course" });
    [student] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "No Upload Student", useMagicLink: true }
    ]);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student]);
  });

  async function startRecording(page: Page, path = "gradebook") {
    await enableRecording(page, course.id);
    await loginAsUser(page, student, course);
    const capture = await captureTunnel(page);
    await page.goto(`/course/${course.id}/${path}`);
    await waitForRecorderState(page, "recording");
    return capture;
  }

  test("B1: 10 minutes across three pages with errors: only error events, carrying replay_id", async ({ page }) => {
    test.setTimeout(180_000);
    await page.clock.install();
    const capture = await startRecording(page, "gradebook");
    const replayId = await page.evaluate(() => window.__bugReportRecorder!.getReplayId());
    expect(replayId).toMatch(/^[0-9a-f]{32}$/);

    const routes = ["office-hours", "discussion", "gradebook"];
    const errors = ["B1 thrown error one", "B1 thrown error two", "B1 thrown error three"];
    for (let minute = 0; minute < 10; minute++) {
      const route = routes[minute % routes.length];
      await clickNavLink(page, `/course/${course.id}/${route}`);
      await waitForRecorderState(page, "recording");
      if (minute < errors.length) {
        await page.evaluate((message) => {
          setTimeout(() => {
            throw new Error(message);
          }, 0);
        }, errors[minute]);
      }
      if (minute === 5) {
        await page.evaluate(() => {
          void Promise.reject(new Error("B1 unhandled rejection"));
        });
      }
      for (let s = 0; s < 6; s++) {
        await page.mouse.move(100 + s * 20, 200 + s * 10);
        await page.clock.fastForward(10_000);
      }
    }
    await page.evaluate(() => window.__bugReportRecorder!.getState());
    const all = [...errors, "B1 unhandled rejection"];
    const envelopes: CapturedEnvelope[] = [];
    for (const message of all) envelopes.push(await capture.waitForEnvelope((e) => mentions(e, message)));

    assertNoReplayUploaded(capture);
    for (const envelope of envelopes) {
      // replay_id travels in the envelope's trace header (the DSC), where Sentry links it.
      expect((envelope.header.trace as { replay_id?: string } | undefined)?.replay_id).toBe(replayId);
      expect(envelope.items.map((i) => i.header.type)).toEqual(["event"]);
      const event = errorEventOf(envelope)!;
      expect(event.type).toBeUndefined();
      // Nothing else replay-related: the id appears once in the whole envelope, in the header.
      const raw = new TextDecoder().decode(envelope.raw);
      expect(raw.split(replayId).length - 1).toBe(1);
      expect(event.contexts?.replay).toBeUndefined();
    }
    // Every envelope any request carried was an error event or a session.
    for (const e of capture.envelopes) {
      for (const item of e.items) expect(["event", "session", "sessions", "client_report"]).toContain(item.header.type);
    }

    const ids = await page.evaluate(() => ({
      errorIds: window.__bugReportRecorder!.getErrorIds(),
      traceIds: window.__bugReportRecorder!.getTraceIds()
    }));
    for (const envelope of envelopes) {
      const event = errorEventOf(envelope)!;
      expect(ids.errorIds).toContain(event.event_id);
      if (event.contexts?.trace?.trace_id) expect(ids.traceIds).toContain(event.contexts.trace.trace_id);
    }
    const buffer = await freeze(page);
    expect(buffer.errorIds).toEqual(ids.errorIds);
    expect(buffer.endTimestamp - buffer.startTimestamp).toBeGreaterThan(8 * 60_000);
  });

  test("B2: freezing for the dialog uploads nothing, and recording continues", async ({ page }) => {
    const capture = await startRecording(page);
    const before = await freeze(page);
    expect(before.segments.length).toBeGreaterThan(0);
    const statsBefore = await recorderStats(page);
    await page.mouse.move(50, 50);
    await page.mouse.move(400, 300);
    await page.evaluate(() => document.body.appendChild(document.createElement("section")));
    await expect.poll(async () => (await recorderStats(page)).events).toBeGreaterThan(statsBefore.events);
    expect(await page.evaluate(() => window.__bugReportRecorder!.getState())).toBe("recording");
    await page.evaluate(() => fetch("/api/does-not-exist").catch(() => undefined));
    assertNoReplayUploaded(capture);
  });

  // TODO(package 5): open "Report a bug" from the user menu, press Cancel; assert the same.
  test.fixme("B2 (package 5): open the review dialog, then Cancel", async () => {});

  test("B3: navigating away or closing after freezing sends no beacon or keepalive", async ({ page, context }) => {
    const capture = await startRecording(page);
    await freeze(page);
    await page.goto("about:blank");
    const second = await context.newPage();
    await second.goto(`/course/${course.id}/gradebook`);
    await waitForRecorderState(second, "recording");
    await freeze(second);
    await second.close({ runBeforeUnload: true });
    const other = await context.newPage();
    await other.goto(`/course/${course.id}`);
    await other.waitForLoadState("load");
    assertNoReplayUploaded(capture);
    const beacons = capture.requests.filter((r) => r.resourceType === "ping" || r.resourceType === "beacon");
    expect(beacons).toEqual([]);
  });

  // TODO(package 5): with the review dialog open, navigate away and close the tab.
  test.fixme("B3 (package 5): navigate away or close with the review dialog open", async () => {});

  test("B4: Sentry flush, close, and a direct feedback event carry no replay", async ({ page }) => {
    const capture = await startRecording(page);
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("B4 error before flush");
      }, 0);
    });
    await capture.waitForEnvelope((e) => mentions(e, "B4 error before flush"));
    await sentryCall(page, "feedback");
    await capture.waitForEnvelope((e) => e.items.some((i) => i.header.type === "feedback"));
    await sentryCall(page, "flush");
    await sentryCall(page, "close");
    assertNoReplayUploaded(capture);
    const feedback = capture.items("feedback").map((i) => payloadJsonOf<ErrorPayload>(i));
    for (const f of feedback) {
      expect((f?.contexts?.feedback as { replay_id?: string } | undefined)?.replay_id).toBeUndefined();
    }
  });

  // TODO(package 5): call Sentry.sendFeedback itself once the dialog's code path bundles it.
  test.fixme("B4 (package 5): Sentry.sendFeedback directly", async () => {});
});
