/**
 * Package 1 recorder tests (PR tier): C1-C6.
 *
 * Needs a build made with E2E_ENABLE=true: the harness page and the test route policy are
 * compiled out otherwise. No Sentry.
 */
/* eslint-disable no-console -- page-side console calls are what the tests record, or measurements printed for the run log */
import { test, expect } from "../../global-setup";
import type { Page } from "@playwright/test";
import { createClass, createUsersInClass, loginAsUser, type TestingUser } from "../TestingUtils";
import {
  allEvents,
  allSerializedNodes,
  breadcrumbs,
  clickNavLink,
  enableRecording,
  freeze,
  isMasked,
  recorderStats,
  waitForRecorderState,
  type SerializedNode
} from "./recorderTestUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

const HARNESS = "/course/[course_id]/e2e-harness/bug-report";

test.describe("bug report recorder buffer", () => {
  test.describe.configure({ mode: "serial" });

  let course: Course;
  let student: TestingUser;

  test.beforeAll(async () => {
    course = await createClass({ name: "Bug Report Recorder Course" });
    [student] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Recorder Buffer Student", useMagicLink: true }
    ]);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student]);
  });

  async function openHarness(page: Page, fixture: string) {
    await enableRecording(page, course.id, [{ pattern: HARNESS, level: "full" }]);
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/e2e-harness/bug-report?fixture=${fixture}`);
    await expect(page.getByRole("heading", { name: "Bug report recorder harness" })).toBeVisible();
    await waitForRecorderState(page, "recording");
  }

  test("C1: 15 minutes of recording keeps at most 10 min + 60 s, starting with a checkout", async ({ page }) => {
    await page.clock.install();
    await openHarness(page, "inputs");
    // 15 minutes of clock time, a DOM change every 10 s.
    for (let i = 0; i < 90; i++) {
      await page.evaluate((n) => {
        const d = document.createElement("div");
        d.textContent = `tick ${n}`;
        document.body.appendChild(d);
      }, i);
      await page.clock.fastForward(10_000);
    }
    await page.evaluate(() => document.body.appendChild(document.createElement("hr")));
    await expect.poll(async () => (await freeze(page)).endTimestamp).toBeGreaterThan(0);

    const buffer = await freeze(page);
    const events = allEvents(buffer);
    expect(events[0].type).toBe(4);
    expect(events[1].type).toBe(2);
    const window = buffer.endTimestamp - buffer.startTimestamp;
    expect(window).toBeLessThanOrEqual(10 * 60_000 + 60_000);
    expect(window).toBeGreaterThanOrEqual(9 * 60_000);
    expect(buffer.segments.length).toBeGreaterThanOrEqual(8);
    for (const seg of buffer.segments) {
      expect(seg.events[0].type).toBe(4);
      expect(seg.events[1].type).toBe(2);
    }
  });

  test("C2: heavy mutation stays under 20 MB by dropping whole old segments", async ({ page }) => {
    test.setTimeout(180_000);
    await openHarness(page, "mutations");
    const cap = 20 * 1024 * 1024;
    // Keep going until well past the cap, so old segments must have been dropped.
    await expect
      .poll(async () => (await recorderStats(page)).totalPushed, { timeout: 120_000, intervals: [2_000] })
      .toBeGreaterThan(cap * 1.5);
    const summary = await page.evaluate(() => {
      const b = window.__bugReportRecorder!.freeze();
      return {
        size: b.size,
        segments: b.segments.map((s) => ({ first: s.events[0].type, second: s.events[1]?.type, size: s.size }))
      };
    });
    expect(summary.size).toBeLessThanOrEqual(cap);
    expect(summary.segments.length).toBeGreaterThan(0);
    for (const seg of summary.segments) {
      expect(seg.first).toBe(4);
      expect(seg.second).toBe(2);
    }
    expect((await recorderStats(page)).size).toBeLessThanOrEqual(cap);
  });

  test("C3: client navigation across 4 listed routes is one recording listing all 4 URLs", async ({ page }) => {
    const routes = ["discussion", "office-hours", "gradebook", "polls"];
    await enableRecording(
      page,
      course.id,
      routes.map((r) => ({ pattern: `/course/[course_id]/${r}`, level: "structure" as const }))
    );
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/${routes[0]}`);
    await waitForRecorderState(page, "recording");
    const replayId = await page.evaluate(() => window.__bugReportRecorder!.getReplayId());
    for (const r of routes.slice(1)) {
      await clickNavLink(page, `/course/${course.id}/${r}`);
      expect(await page.evaluate(() => window.__bugReportRecorder?.getState())).toBe("recording");
    }
    await page.waitForLoadState("networkidle");

    const buffer = await freeze(page);
    expect(buffer.replayId).toBe(replayId);
    expect(buffer.replayId).toMatch(/^[0-9a-f]{32}$/);
    const paths = buffer.urls.map((u) => new URL(u).pathname);
    for (const r of routes) expect(paths).toContain(`/course/${course.id}/${r}`);
    // Same level throughout, so rrweb never restarted: one Meta per checkout, none per route.
    const metaHrefs = allEvents(buffer)
      .filter((e) => e.type === 4)
      .map((e) => new URL((e.data as { href: string }).href).pathname);
    expect(metaHrefs[0]).toBe(`/course/${course.id}/${routes[0]}`);
    expect(buffer.segments.length).toBe(metaHrefs.length);
    // Mutations from every route are in the buffer.
    const incremental = allEvents(buffer).filter((e) => e.type === 3);
    expect(incremental.length).toBeGreaterThan(routes.length);
  });

  test("C4: console, click, and fetch breadcrumbs; fetch has no bodies or headers", async ({ page }) => {
    await openHarness(page, "inputs");
    await page.getByRole("heading", { name: "Bug report recorder harness" }).click();
    await page.evaluate(async () => {
      console.log("c4-console-marker", { answer: 42 });
      console.error("c4-console-error");
      await fetch("/api/bug-report-c4-probe?apikey=c4-query-secret&x=1", {
        method: "POST",
        body: "c4-body-canary",
        headers: { "X-C4-Header": "c4-header-canary" }
      }).catch(() => undefined);
    });
    // A Supabase request made after the recorder started, through the early fetch hook.
    await clickNavLink(page, `/course/${course.id}/office-hours`);
    await page.waitForLoadState("networkidle");
    await clickNavLink(page, `/course/${course.id}/e2e-harness/bug-report`);
    await waitForRecorderState(page, "recording");

    await expect
      .poll(async () => breadcrumbs(await freeze(page)).filter((b) => b.category === "fetch").length)
      .toBeGreaterThan(0);
    const buffer = await freeze(page);
    const crumbs = breadcrumbs(buffer);
    const consoleCrumbs = crumbs.filter((b) => b.category === "console");
    expect(consoleCrumbs).toContainEqual(
      expect.objectContaining({ level: "log", message: 'c4-console-marker {"answer":42}' })
    );
    expect(consoleCrumbs).toContainEqual(expect.objectContaining({ level: "error", message: "c4-console-error" }));

    const clicks = crumbs.filter((b) => b.category === "ui.click");
    expect(clicks.some((c) => c.message?.startsWith("h2") && typeof c.data?.nodeId === "number")).toBe(true);

    const fetches = crumbs.filter((b) => b.category === "fetch");
    const probe = fetches.find((f) => String(f.data?.url).includes("/api/bug-report-c4-probe"));
    expect(probe).toBeDefined();
    expect(Object.keys(probe!.data!).sort()).toEqual(["duration", "method", "status_code", "url"]);
    expect(probe!.data!.method).toBe("POST");
    expect(typeof probe!.data!.status_code).toBe("number");
    expect(probe!.data!.status_code).toBeGreaterThan(0);
    expect(typeof probe!.data!.duration).toBe("number");
    for (const f of fetches) expect(Object.keys(f.data!).sort()).toEqual(["duration", "method", "status_code", "url"]);
    expect(fetches.some((f) => String(f.data?.url).includes("/rest/v1/"))).toBe(true);

    const json = JSON.stringify(crumbs);
    expect(json).not.toContain("c4-body-canary");
    expect(json).not.toContain("c4-header-canary");
    expect(json).not.toContain("c4-query-secret");
  });

  test("C5: input values are masked; password, token, and hidden fields are never recorded", async ({ page }) => {
    await openHarness(page, "inputs");
    await page.getByTestId("text-input").fill("typed-canary-value");
    await page.getByTestId("email-input").fill("c5-canary@example.com");
    await page.getByTestId("textarea-input").fill("notes canary words");
    await page.getByTestId("select-input").selectOption("b");
    await page.getByTestId("password-input").fill("pw-canary-123");
    await page.getByTestId("token-input").fill("tok-canary-456");

    type InputEvent = { id: number; text: string };
    const inputEvents = (b: Awaited<ReturnType<typeof freeze>>) =>
      allEvents(b)
        .filter((e) => e.type === 3 && (e.data as { source: number }).source === 5)
        .map((e) => e.data as unknown as InputEvent);
    await expect.poll(async () => inputEvents(await freeze(page)).length).toBeGreaterThanOrEqual(4);

    const buffer = await freeze(page);
    const json = JSON.stringify(buffer);
    for (const canary of [
      "typed-canary-value",
      "c5-canary@example.com",
      "notes canary words",
      "pw-canary-123",
      "tok-canary-456",
      "hidden-canary-value",
      "Option beta"
    ]) {
      expect(json).not.toContain(canary);
    }
    for (const e of inputEvents(buffer)) expect(isMasked(e.text)).toBe(true);

    const nodes = allSerializedNodes(buffer);
    const inputs = nodes.filter((n) => n.tagName === "input");
    const blocked = inputs.filter((n) => n.attributes?.rr_width !== undefined);
    // password, api_token, hidden csrf
    expect(blocked.length).toBe(3);
    for (const n of blocked) {
      expect(Object.keys(n.attributes ?? {}).every((k) => ["class", "rr_width", "rr_height"].includes(k))).toBe(true);
    }
    const blockedIds = new Set(blocked.map((n) => n.id));
    expect(inputEvents(buffer).filter((e) => blockedIds.has(e.id))).toEqual([]);
    // The text input is recorded, with its value masked.
    const text = inputs.find((n) => n.attributes?.name === "display_name");
    expect(text).toBeDefined();
  });

  test("C6: Monaco, the markdown editor, images, media, and avatars are size-only placeholders", async ({ page }) => {
    await openHarness(page, "media");
    await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".w-md-editor")).toBeVisible();

    const blockedBy = (nodes: SerializedNode[], classPart: string, tag?: string) =>
      nodes.filter(
        (n) =>
          (tag === undefined || n.tagName === tag) &&
          String(n.attributes?.class ?? "")
            .split(/\s+/)
            .some((c) => c === classPart || c.startsWith(classPart))
      );
    await expect
      .poll(async () => blockedBy(allSerializedNodes(await freeze(page)), "monaco-editor").length)
      .toBeGreaterThan(0);

    const buffer = await freeze(page);
    const nodes = allSerializedNodes(buffer);
    const expectPlaceholder = (label: string, found: SerializedNode[]) => {
      expect(found.length, label).toBeGreaterThan(0);
      for (const n of found) {
        expect(Object.keys(n.attributes ?? {}).sort(), label).toEqual(
          expect.arrayContaining(["rr_height", "rr_width"])
        );
        expect(
          Object.keys(n.attributes ?? {}).every((k) => ["class", "rr_width", "rr_height"].includes(k)),
          label
        ).toBe(true);
        expect(n.childNodes ?? [], label).toEqual([]);
      }
    };
    expectPlaceholder("image", blockedBy(nodes, "c6-image", "img"));
    expectPlaceholder("video", blockedBy(nodes, "c6-video", "video"));
    expectPlaceholder("canvas", blockedBy(nodes, "c6-canvas", "canvas"));
    expectPlaceholder("data-report-block", blockedBy(nodes, "c6-report-block"));
    expectPlaceholder("avatar", blockedBy(nodes, "chakra-avatar__root"));
    expectPlaceholder("monaco", blockedBy(nodes, "monaco-editor"));
    expectPlaceholder("markdown editor", blockedBy(nodes, "w-md-editor"));
    // No img anywhere keeps a src.
    expect(nodes.filter((n) => n.tagName === "img" && n.attributes?.src !== undefined)).toEqual([]);

    const json = JSON.stringify(buffer);
    for (const canary of [
      "SecretCode",
      "int canary",
      "markdown canary text",
      "Avatar Canary Person",
      "data:image/svg"
    ]) {
      expect(json).not.toContain(canary);
    }
  });
});
