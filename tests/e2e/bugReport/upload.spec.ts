/**
 * Package 6 upload tests (PR tier): F1, F2, F5, F6.
 *
 * Needs a build made with E2E_ENABLE=true (for the upload hook and the harness page) and any
 * NEXT_PUBLIC_SENTRY_DSN, so the browser SDK has a transport. `captureTunnel` answers every
 * envelope itself; nothing leaves the machine.
 *
 * The review dialog's replay half is package 5b and doesn't exist yet, so these submit through
 * `window.__bugReportE2E.submitWithReplay`: freeze the buffer, then the real `submitReport` with
 * `uploadReplay` attached. That is the code path the dialog's Submit will take.
 */
/* eslint-disable no-console -- measurements and evidence printed for the run log */
import { test, expect } from "../../global-setup";
import type { Page } from "@playwright/test";
import { inflateSync } from "node:zlib";
import { MAX_SEGMENT_COMPRESSED_BYTES } from "@/lib/bugReport/upload/segments";
import { createClass, createUsersInClass, loginAsUser, type TestingUser } from "../TestingUtils";
import { captureTunnel, parseCapturedEnvelope, type TunnelCapture, type TunnelResponder } from "./index";
import { clickNavLink, enableRecording, recorderStats, waitForRecorderState } from "./recorderTestUtils";
import { feedbackEnvelopes, recordMinutes, replaySegments, submitWithReplay } from "./uploadTestUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

const HARNESS = "/course/[course_id]/e2e-harness/bug-report";
const MiB = 1024 * 1024;

test.describe("bug report replay upload", () => {
  let course: Course;
  let student: TestingUser;

  test.beforeAll(async () => {
    course = await createClass({ name: "Bug Report Upload Course" });
    [student] = await createUsersInClass([
      { role: "student", class_id: course.id, name: "Upload Student", useMagicLink: true }
    ]);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student]);
  });

  async function startOnGradebook(page: Page, respond?: TunnelResponder): Promise<TunnelCapture> {
    await page.clock.install();
    await enableRecording(page, course.id);
    await loginAsUser(page, student, course);
    const capture = await captureTunnel(page, { respond });
    await page.goto(`/course/${course.id}/gradebook`);
    await waitForRecorderState(page, "recording");
    return capture;
  }

  /** Three checkouts' worth of recording, with an error so error_ids and trace_ids are set. */
  async function recordThreeMinutes(page: Page) {
    await recordMinutes(page, 3, async (m) => {
      if (m === 1) {
        await clickNavLink(page, `/course/${course.id}/office-hours`);
        await waitForRecorderState(page, "recording");
        await page.evaluate(() => {
          setTimeout(() => {
            throw new Error("F1 error during recording");
          }, 0);
        });
      }
    });
  }

  test("F1: a 3-minute recording uploads as well-formed buffer replay segments", async ({ page }) => {
    test.setTimeout(180_000);
    const capture = await startOnGradebook(page);
    await recordThreeMinutes(page);
    await capture.waitForEnvelope((e) => new TextDecoder().decode(e.raw).includes("F1 error during recording"));

    const out = await submitWithReplay(page, { description: "F1 report", contactOk: true }, { clock: true });
    expect(out.result).toMatchObject({ status: "sent", replay: "attached" });
    expect(out.upload).toMatchObject({ ok: true, replayId: out.replayId });

    const segments = replaySegments(capture);
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(out.replayId).toMatch(/^[0-9a-f]{32}$/);
    const startTs = segments[0].event.replay_start_timestamp;
    segments.forEach((s, i) => {
      // One replay_event and one replay_recording, nothing else.
      expect(s.envelope.items.map((it) => it.header.type)).toEqual(["replay_event", "replay_recording"]);
      expect(s.envelope.header.event_id).toBe(out.replayId);
      expect(s.event.type).toBe("replay_event");
      expect(s.event.replay_id).toBe(out.replayId);
      expect(s.event.event_id).toBe(out.replayId);
      expect(s.event.segment_id).toBe(i);
      expect(s.event.replay_type).toBe("buffer");
      expect(s.event.replay_start_timestamp).toBe(startTs);
      expect(s.event.timestamp).toBeGreaterThanOrEqual(startTs);
      expect(Array.isArray(s.event.urls)).toBe(true);
      expect(Array.isArray(s.event.error_ids)).toBe(true);
      expect(Array.isArray(s.event.trace_ids)).toBe(true);
      expect(s.event.tags).toEqual({
        class_id: String(course.id),
        role: "student",
        route: "/course/[course_id]/office-hours",
        contact_ok: "true",
        ...(s.event.tags.release ? { release: s.event.tags.release } : {})
      });
      expect(s.event.user).toEqual({ id: student.user_id, ip_address: null });
      expect(JSON.stringify(s.event)).not.toContain(student.email);
      expect(s.event).not.toHaveProperty("breadcrumbs");
      // Body: the segment_id line, then a zlib stream of rrweb events.
      const payload = s.recording.payload;
      const newline = payload.indexOf(0x0a);
      expect(new TextDecoder().decode(payload.subarray(0, newline))).toBe(`{"segment_id":${i}}`);
      const zlib = payload.subarray(newline + 1);
      expect(zlib[0]).toBe(0x78);
      const events = JSON.parse(inflateSync(zlib).toString("utf8")) as { type: number; timestamp: number }[];
      expect(events.length).toBeGreaterThan(0);
      expect(s.recording.recordingEvents).toEqual(events);
      if (i > 0) expect(s.event.timestamp).toBeGreaterThanOrEqual(segments[i - 1].event.timestamp);
    });
    // Segment 0 is where the lists live.
    const first = segments[0].event;
    expect(first.urls).toEqual(out.buffer.urls);
    expect(first.urls.some((u) => u.endsWith("/gradebook"))).toBe(true);
    expect(first.urls.some((u) => u.endsWith("/office-hours"))).toBe(true);
    expect(first.error_ids).toEqual(out.buffer.errorIds);
    expect(first.error_ids.length).toBeGreaterThan(0);
    expect(first.trace_ids.length).toBeGreaterThan(0);
    expect(first.replay_start_timestamp).toBe(out.buffer.startTimestamp / 1000);
    const firstEvents = segments[0].recording.recordingEvents as { type: number }[];
    expect(firstEvents[0].type).toBe(4);
    expect(firstEvents[1].type).toBe(2);
    // Span: about three minutes.
    const last = segments[segments.length - 1].event;
    expect(last.timestamp - first.replay_start_timestamp).toBeGreaterThan(170);
  });

  test("F2: a recording over 8 MiB compressed splits into segments under the cap", async ({ page }) => {
    test.setTimeout(300_000);
    await enableRecording(page, course.id, [{ pattern: HARNESS, level: "full" }]);
    await loginAsUser(page, student, course);
    const capture = await captureTunnel(page);
    await page.goto(`/course/${course.id}/e2e-harness/bug-report?fixture=entropy`);
    await waitForRecorderState(page, "recording");
    // Random base64 compresses to about 3/4, so 12M characters is about 9 MiB compressed.
    await expect
      .poll(async () => (await recorderStats(page)).size, { timeout: 150_000, intervals: [2_000] })
      .toBeGreaterThan(12_000_000);

    const out = await submitWithReplay(page, { description: "F2 report" }, { timeout: 180_000 });
    expect(out.result).toMatchObject({ status: "sent", replay: "attached" });

    const segments = replaySegments(capture);
    const total = segments.reduce((n, s) => n + s.compressedBytes, 0);
    console.log(
      `[bug-report F2] buffer ${out.buffer.size} chars in ${out.buffer.checkouts} checkouts -> ${segments.length} segments, ` +
        `${(total / MiB).toFixed(2)} MiB compressed, largest ${(Math.max(...segments.map((s) => s.compressedBytes)) / 1024).toFixed(0)} KiB, ` +
        `compress ${Math.round(out.stats!.compressMs)} ms, send ${Math.round(out.stats!.sendMs)} ms`
    );
    expect(total).toBeGreaterThan(8 * MiB);
    expect(segments.length).toBeGreaterThan(out.buffer.checkouts);
    expect(segments.map((s) => s.event.segment_id)).toEqual(segments.map((_, i) => i));
    for (const s of segments) {
      expect(s.compressedBytes).toBeLessThanOrEqual(MAX_SEGMENT_COMPRESSED_BYTES);
      expect(s.compressedBytes).toBeLessThanOrEqual(8 * MiB);
      expect(s.recording.recordingEvents?.length).toBeGreaterThan(0);
    }
    const first = segments[0].recording.recordingEvents as { type: number }[];
    expect(first[0].type).toBe(4);
    expect(first[1].type).toBe(2);
    // Continuations: timestamps never go backwards across segments.
    const all = segments.flatMap((s) => s.recording.recordingEvents as { timestamp: number }[]);
    for (let i = 1; i < all.length; i++) expect(all[i].timestamp).toBeGreaterThanOrEqual(all[i - 1].timestamp);
    expect(all.length).toBe(out.buffer.events);
    expect(out.upload).toMatchObject({ ok: true, segments: segments.length });
    expect(out.upload).not.toHaveProperty("dropped");
  });

  test("F5: feedback goes out only after every segment got a 2xx, pointing at the replay", async ({ page }) => {
    test.setTimeout(180_000);
    const capture = await startOnGradebook(page);
    // Registered after captureTunnel, so it sees each request first. It answers replay
    // segments itself and logs when each arrived and when its 200 was delivered; everything
    // else goes on to captureTunnel.
    const log: string[] = [];
    const replayIds = new Set<string>();
    await page.context().route("**/api/tunnel", async (route) => {
      const body = route.request().postDataBuffer();
      const env = parseCapturedEnvelope(body ? new Uint8Array(body) : new Uint8Array());
      const seg = env.items.find((i) => i.header.type === "replay_recording")?.segmentHeader?.segment_id;
      if (seg !== undefined) {
        replayIds.add(String(env.header.event_id));
        log.push(`arrived ${seg}`);
        // Give the page a few turns of its event loop with the segment unanswered: a client
        // that didn't wait for the 2xx would send the next segment or the feedback now.
        for (let i = 0; i < 5; i++) await page.evaluate(() => new Promise((r) => queueMicrotask(() => r(null))));
        log.push(`answered ${seg}`);
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      if (env.items.some((i) => i.header.type === "feedback")) log.push("feedback");
      await route.fallback();
    });
    await recordThreeMinutes(page);

    const out = await submitWithReplay(page, { description: "F5 report" }, { clock: true });
    expect(out.result).toMatchObject({ status: "sent", replay: "attached" });
    const n = out.upload && out.upload.ok ? out.upload.segments! : 0;
    expect(n).toBeGreaterThanOrEqual(3);
    expect([...replayIds]).toEqual([out.replayId]);

    // Sequential: nothing arrives while a segment is unanswered, and the feedback comes last.
    const expected = Array.from({ length: n }, (_, i) => [`arrived ${i}`, `answered ${i}`])
      .flat()
      .concat("feedback");
    expect(log).toEqual(expected);
    const feedback = feedbackEnvelopes(capture);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].event.contexts?.feedback?.replay_id).toBe(out.replayId);
    expect(feedback[0].event.tags).not.toHaveProperty("replay_upload");
  });

  test.describe("F6: failures", () => {
    test("a 5xx on segment 1 is retried, then the upload succeeds", async ({ page }) => {
      test.setTimeout(180_000);
      let failed = 0;
      const capture = await startOnGradebook(page, (env) => {
        const seg = env.items.find((i) => i.header.type === "replay_recording")?.segmentHeader?.segment_id;
        if (seg === 1 && failed === 0) {
          failed++;
          return { status: 503, body: "upstream unavailable" };
        }
        return undefined;
      });
      await recordThreeMinutes(page);
      const out = await submitWithReplay(page, { description: "F6 retry" }, { clock: true });
      expect(out.result).toMatchObject({ status: "sent", replay: "attached" });
      expect(out.stats!.attempts[0]).toBe(1);
      expect(out.stats!.attempts[1]).toBe(2);
      const ids = replaySegments(capture).map((s) => s.event.segment_id);
      expect(ids.slice(0, 3)).toEqual([0, 1, 1]);
      expect([...new Set(ids)]).toEqual(ids.filter((id, i) => ids.indexOf(id) === i));
      expect(feedbackEnvelopes(capture)[0].event.contexts?.feedback?.replay_id).toBe(out.replayId);
    });

    test("a 429 stops the report: no retry, no feedback, 'try again later'", async ({ page }) => {
      test.setTimeout(180_000);
      const capture = await startOnGradebook(page, (env) => {
        const seg = env.items.find((i) => i.header.type === "replay_recording")?.segmentHeader?.segment_id;
        return seg === 1 ? { status: 429, headers: { "retry-after": "60" } } : undefined;
      });
      await recordThreeMinutes(page);
      const out = await submitWithReplay(page, { description: "F6 rate limited" }, { clock: true });
      // The dialog shows "Try again later" for this result (dialog.spec.ts covers the mapping).
      expect(out.result).toEqual({ status: "rate_limited" });
      expect(out.upload).toMatchObject({ ok: false, reason: "rate_limited" });
      expect(replaySegments(capture).map((s) => s.event.segment_id)).toEqual([0, 1]);
      expect(feedbackEnvelopes(capture)).toEqual([]);
    });

    test("a permanent failure (413) still sends the feedback, without replay_id", async ({ page }) => {
      test.setTimeout(180_000);
      const capture = await startOnGradebook(page, (env) =>
        env.items.some((i) => i.header.type === "replay_event")
          ? { status: 413, body: "envelope exceeded size limits" }
          : undefined
      );
      await recordThreeMinutes(page);
      const out = await submitWithReplay(page, { description: "F6 too large" }, { clock: true });
      expect(out.result).toMatchObject({ status: "sent", replay: "failed" });
      expect(replaySegments(capture)).toHaveLength(1);
      const [feedback] = feedbackEnvelopes(capture);
      expect(feedback.event.contexts?.feedback).not.toHaveProperty("replay_id");
      expect(feedback.event.tags?.replay_upload).toBe("failed");
    });

    test("retries that run out still send the feedback, without replay_id", async ({ page }) => {
      test.setTimeout(180_000);
      const capture = await startOnGradebook(page, (env) =>
        env.items.some((i) => i.header.type === "replay_event") ? { status: 503 } : undefined
      );
      await recordThreeMinutes(page);
      const out = await submitWithReplay(page, { description: "F6 retries exhausted" }, { clock: true });
      expect(out.result).toMatchObject({ status: "sent", replay: "failed" });
      expect(replaySegments(capture).map((s) => s.event.segment_id)).toEqual([0, 0, 0]);
      const [feedback] = feedbackEnvelopes(capture);
      expect(feedback.event.contexts?.feedback).not.toHaveProperty("replay_id");
      expect(feedback.event.tags?.replay_upload).toBe("failed");
    });
  });
});
