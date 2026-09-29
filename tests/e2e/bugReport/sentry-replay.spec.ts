/**
 * F7 (nightly and release tiers): a bug report with a replay, uploaded from the browser through
 * /api/tunnel to the real dev Sentry, checked through the Sentry web API. Skipped when the
 * SENTRY_* variables are absent (PR tier). F8, the smoke test the nightly suite runs first, is
 * sentry-smoke.spec.ts.
 *
 * Needs a full-profile build made with E2E_ENABLE=true (for the upload hook and the harness page)
 * and NEXT_PUBLIC_SENTRY_DSN pointing at the dev Sentry.
 *
 * Everything is read back FROM Sentry: a 2xx from ingest proves nothing on its own, because the
 * dev Sentry has accepted replay segments and then dropped them (see MAX_SEGMENT_COMPRESSED_BYTES).
 */
/* eslint-disable no-console -- measurements and evidence printed for the run log */
import { test, expect } from "../../global-setup";
import type { Page } from "@playwright/test";
import { loginAsUser } from "../TestingUtils";
import { seedCanaryClass, type CanarySeed } from "./canarySeed";
import {
  captureTunnel,
  describeHits,
  payloadJsonOf,
  scanForCanaries,
  sentryApiFromEnv,
  type CanaryRegistry,
  type SentryApi,
  type TunnelCapture
} from "./index";
import { clickNavLink, enableRecording, recorderStats, waitForRecorderState } from "./recorderTestUtils";
import { replaySegments, recordMinutes, submitWithReplay, type E2ESubmitOutput } from "./uploadTestUtils";

const sentry = sentryApiFromEnv();
const HARNESS = "/course/[course_id]/e2e-harness/bug-report";

type ReplayDetails = {
  id: string;
  replay_type: string;
  count_segments: number;
  count_errors: number;
  error_ids: string[];
  trace_ids: string[];
  urls: string[];
  tags: Record<string, string[]>;
  user: { id?: string | null; email?: string | null; username?: string | null; display_name?: string | null };
  started_at: string;
  finished_at: string;
};

async function waitForReplay(api: SentryApi, replayId: string, segments: number, timeoutMs = 120_000) {
  return api.waitFor(
    `replay ${replayId} with ${segments} segments`,
    async () => {
      const r = await api.replay(replayId);
      const d = r?.data as ReplayDetails | undefined;
      return d && d.count_segments >= segments ? d : null;
    },
    { timeoutMs, intervalMs: 5_000 }
  );
}

/** The recording as Sentry stores it: one array of rrweb events per segment. */
async function downloadSegments(
  api: SentryApi,
  replayId: string
): Promise<{ bytes: Uint8Array; segments: unknown[][] }> {
  const bytes = await api.waitFor(`recording of ${replayId}`, () => api.recordingSegments(replayId), {
    timeoutMs: 60_000,
    intervalMs: 5_000
  });
  return { bytes, segments: JSON.parse(new TextDecoder().decode(bytes)) as unknown[][] };
}

function uploadedEvents(capture: TunnelCapture): unknown[][] {
  return replaySegments(capture)
    .filter((s) => s.envelope.status === 200)
    .map((s) => s.recording.recordingEvents as unknown[]);
}

test.describe("replay upload to the dev Sentry (F7)", () => {
  test.skip(!sentry, "SENTRY_URL / SENTRY_ORG / SENTRY_PROJECT / SENTRY_AUTH_TOKEN not set");
  test.describe.configure({ mode: "serial" });

  let seed: CanarySeed;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    seed = await seedCanaryClass();
  });

  async function start(page: Page, policy?: Parameters<typeof enableRecording>[2]) {
    const student = seed.students[0];
    await enableRecording(page, seed.course.id, policy);
    await loginAsUser(page, student, seed.course);
    return { student };
  }

  test("a backdated buffer replay with a linked error, feedback, and nothing a canary can find", async ({
    page
  }, testInfo) => {
    test.setTimeout(600_000);
    const api = sentry!;
    const { student } = await start(page);
    // Page time starts 6 minutes in the past, so the whole recording is backdated, as a real
    // buffer is when the user reports minutes after the fact (open question 2).
    await page.clock.install({ time: Date.now() - 6 * 60_000 });
    const capture = await captureTunnel(page, { forward: true });
    await page.goto(seed.routes.studentGradebook);
    await waitForRecorderState(page, "recording");

    await recordMinutes(page, 3, async (m) => {
      if (m === 1) {
        // Client navigations: a full load would start a new recorder and a new replay.
        await clickNavLink(page, seed.routes.officeHours);
        await waitForRecorderState(page, "recording");
        await clickNavLink(page, seed.routes.studentGradebook);
        await waitForRecorderState(page, "recording");
        await page.evaluate(() => {
          setTimeout(() => {
            throw new Error("F7 linked error during recording");
          }, 0);
        });
      }
    });
    const errorEnvelope = await capture.waitForEnvelope((e) =>
      e.items.some((i) => i.header.type === "event" && JSON.stringify(payloadJsonOf(i)).includes("F7 linked error"))
    );
    expect(errorEnvelope.status).toBe(200);
    const errorId = String(errorEnvelope.header.event_id);

    const out: E2ESubmitOutput = await submitWithReplay(
      page,
      { description: "F7 synthetic bug report: the gradebook froze.", contactOk: true },
      { clock: true, timeout: 180_000 }
    );
    expect(out.result).toMatchObject({ status: "sent", replay: "attached" });
    expect(out.buffer.errorIds).toContain(errorId);
    const segments = replaySegments(capture);
    expect(segments.every((s) => s.envelope.status === 200)).toBe(true);
    const feedbackId = out.result.status === "sent" ? out.result.feedbackId : "";
    const evidence: Record<string, unknown> = {
      replayId: out.replayId,
      feedbackId,
      errorId,
      segmentsSent: segments.length,
      compressedBytes: out.stats?.compressedBytes,
      sendMs: Math.round(out.stats?.sendMs ?? 0)
    };

    // Feedback: exists, tagged, points at the replay.
    const feedback = await api.waitFor(`feedback ${feedbackId}`, () => api.event(feedbackId), { timeoutMs: 90_000 });
    const fbTags = Object.fromEntries(feedback.tags.map((t) => [t.key, t.value]));
    expect(fbTags).toMatchObject({
      class_id: String(seed.course.id),
      role: "student",
      route: "/course/[course_id]/gradebook",
      contact_ok: "true"
    });
    expect(fbTags.release).toBeTruthy();
    expect((feedback.contexts?.feedback as { replay_id?: string }).replay_id).toBe(out.replayId);
    expect(feedback.user?.id).toBe(student.user_id);
    expect(feedback.user?.email ?? null).toBeNull();
    expect(feedback.user?.name ?? null).toBeNull();
    evidence.feedbackTags = fbTags;

    // Replay: stored with every segment, as a buffer replay, tagged, user by id only.
    const replay = await waitForReplay(api, out.replayId, segments.length);
    expect(replay.replay_type).toBe("buffer");
    expect(replay.count_segments).toBe(segments.length);
    expect(replay.tags.class_id).toEqual([String(seed.course.id)]);
    expect(replay.tags.role).toEqual(["student"]);
    expect(replay.tags.route).toEqual(["/course/[course_id]/gradebook"]);
    expect(replay.tags.contact_ok).toEqual(["true"]);
    expect(replay.tags.release?.length).toBe(1);
    expect(replay.user.id).toBe(student.user_id);
    expect(replay.user.email ?? null).toBeNull();
    expect(replay.user.username ?? null).toBeNull();
    expect(replay.urls.some((u) => u.endsWith("/office-hours"))).toBe(true);
    evidence.replay = {
      replay_type: replay.replay_type,
      count_segments: replay.count_segments,
      started_at: replay.started_at,
      finished_at: replay.finished_at,
      urls: replay.urls.length,
      userKeysSet: Object.entries(replay.user)
        .filter(([, v]) => v)
        .map(([k]) => k)
    };

    // Recording, downloaded from Sentry: every segment, byte-for-byte what was sent, starting
    // with a checkout, and no canary anywhere in it.
    const { bytes, segments: stored } = await downloadSegments(api, out.replayId);
    expect(stored).toEqual(uploadedEvents(capture));
    expect((stored[0][0] as { type: number }).type).toBe(4);
    expect((stored[0][1] as { type: number }).type).toBe(2);
    const hits = scanForCanaries(bytes, seed.registry as unknown as CanaryRegistry);
    expect(hits, describeHits(hits)).toEqual([]);
    const feedbackHits = scanForCanaries(JSON.stringify(feedback), seed.registry as unknown as CanaryRegistry);
    expect(feedbackHits, describeHits(feedbackHits)).toEqual([]);
    evidence.downloadedBytes = bytes.length;

    // Linked error: on the replay (count_errors lags about a minute behind error_ids).
    const linked = await api.waitFor(
      `error ${errorId} linked to replay ${out.replayId}`,
      async () => {
        const d = (await api.replay(out.replayId))?.data as ReplayDetails | undefined;
        return d && d.error_ids.includes(errorId) && d.count_errors >= 1 ? d : null;
      },
      { timeoutMs: 240_000, intervalMs: 10_000 }
    );
    expect(linked.error_ids).toContain(errorId);
    const errorEvent = await api.waitFor(`error ${errorId}`, () => api.event(errorId));
    expect((errorEvent.contexts?.replay as { replay_id?: string } | undefined)?.replay_id).toBe(out.replayId);
    evidence.linked = { count_errors: linked.count_errors, error_ids: linked.error_ids.length };

    console.log(`[bug-report F7] ${JSON.stringify(evidence)}`);
    await testInfo.attach("f7-evidence.json", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json"
    });
  });

  test("segments near the size cap pass the tunnel and are stored", async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    const api = sentry!;
    await start(page, [{ pattern: HARNESS, level: "full" }]);
    const capture = await captureTunnel(page, { forward: true });
    await page.goto(`/course/${seed.course.id}/e2e-harness/bug-report?fixture=entropy`);
    await waitForRecorderState(page, "recording");
    // About 3 MiB compressed: several segments close to 900 KiB.
    await expect
      .poll(async () => (await recorderStats(page)).size, { timeout: 120_000, intervals: [1_000] })
      .toBeGreaterThan(4_000_000);
    const out = await submitWithReplay(page, { description: "F7 large segments" }, { timeout: 300_000 });
    expect(out.result).toMatchObject({ status: "sent", replay: "attached" });
    const segments = replaySegments(capture);
    expect(segments.every((s) => s.envelope.status === 200)).toBe(true);
    const largest = Math.max(...segments.map((s) => s.compressedBytes));
    expect(largest).toBeGreaterThan(700 * 1024);

    const replay = await waitForReplay(api, out.replayId, segments.length, 180_000);
    expect(replay.count_segments).toBe(segments.length);
    const { segments: stored } = await downloadSegments(api, out.replayId);
    expect(stored.length).toBe(segments.length);
    expect(stored).toEqual(uploadedEvents(capture));
    const evidence = {
      replayId: out.replayId,
      segments: segments.length,
      compressedKiB: segments.map((s) => Math.round(s.compressedBytes / 1024)),
      stored: stored.length,
      sendMs: Math.round(out.stats?.sendMs ?? 0)
    };
    console.log(`[bug-report F7 large] ${JSON.stringify(evidence)}`);
    await testInfo.attach("f7-large-evidence.json", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json"
    });
  });
});
