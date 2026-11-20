/**
 * Helpers for the replay upload specs (package 6): submitting through the E2E upload hook
 * (`lib/bugReport/upload/e2eHook.ts`) and reading replay envelopes out of a tunnel capture.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { E2ESubmitInput, E2ESubmitOutput } from "@/lib/bugReport/upload/e2eHook";
import { payloadJsonOf, type CapturedEnvelope, type CapturedItem, type TunnelCapture } from "./tunnel";

export type { E2ESubmitOutput };

type HookWindow = Window & { __pkg6Result?: E2ESubmitOutput | { error: string } };

/**
 * Freezes the recorder and submits a report with the replay attached, the way the dialog's
 * Submit will once package 5b exists. With `clock`, advances `page.clock` while waiting so
 * the retry backoff and send timeouts (page timers) run.
 */
export async function submitWithReplay(
  page: Page,
  input: E2ESubmitInput,
  { clock = false, timeout = 120_000 }: { clock?: boolean; timeout?: number } = {}
): Promise<E2ESubmitOutput> {
  await page.waitForFunction(() => window.__bugReportE2E !== undefined, undefined, { timeout: 20_000 });
  await page.evaluate((i) => {
    const w = window as HookWindow;
    delete w.__pkg6Result;
    window
      .__bugReportE2E!.submitWithReplay(i)
      .then((r) => (w.__pkg6Result = r))
      .catch((e: unknown) => (w.__pkg6Result = { error: e instanceof Error ? e.message : String(e) }));
  }, input);
  await expect
    .poll(
      async () => {
        if (clock) await page.clock.runFor(1_000);
        return page.evaluate(() => (window as HookWindow).__pkg6Result !== undefined);
      },
      { timeout, intervals: [250] }
    )
    .toBe(true);
  const out = await page.evaluate(() => (window as HookWindow).__pkg6Result!);
  if ("error" in out) throw new Error(`submitWithReplay failed in the page: ${out.error}`);
  return out;
}

export type ReplayEventPayload = {
  type: string;
  event_id: string;
  replay_id: string;
  segment_id: number;
  replay_type: string;
  replay_start_timestamp: number;
  timestamp: number;
  urls: string[];
  error_ids: string[];
  trace_ids: string[];
  tags: Record<string, string>;
  user: Record<string, unknown>;
  [key: string]: unknown;
};

export type CapturedSegment = {
  envelopeIndex: number;
  envelope: CapturedEnvelope;
  event: ReplayEventPayload;
  recording: CapturedItem;
  /** Bytes after the `{"segment_id":n}` line, as sent (compressed). */
  compressedBytes: number;
};

/** Every envelope carrying a replay_event, with its parts, in arrival order. */
export function replaySegments(capture: TunnelCapture): CapturedSegment[] {
  const out: CapturedSegment[] = [];
  capture.envelopes.forEach((envelope, envelopeIndex) => {
    const eventItem = envelope.items.find((i) => i.header.type === "replay_event");
    if (!eventItem) return;
    const recording = envelope.items.find((i) => i.header.type === "replay_recording")!;
    const newline = recording.payload.indexOf(0x0a);
    out.push({
      envelopeIndex,
      envelope,
      event: payloadJsonOf<ReplayEventPayload>(eventItem)!,
      recording,
      compressedBytes: recording.payload.length - newline - 1
    });
  });
  return out;
}

export type FeedbackPayload = {
  event_id: string;
  type: string;
  tags?: Record<string, string>;
  user?: Record<string, unknown>;
  contexts?: { feedback?: { replay_id?: string; message?: string } };
};

/** The feedback envelopes, in arrival order. */
export function feedbackEnvelopes(capture: TunnelCapture): { envelopeIndex: number; event: FeedbackPayload }[] {
  const out: { envelopeIndex: number; event: FeedbackPayload }[] = [];
  capture.envelopes.forEach((envelope, envelopeIndex) => {
    const item = envelope.items.find((i) => i.header.type === "feedback");
    if (item) out.push({ envelopeIndex, event: payloadJsonOf<FeedbackPayload>(item)! });
  });
  return out;
}

/** Generates `minutes` of recording on a fake clock: a DOM change and a pointer move every 10 s. */
export async function recordMinutes(page: Page, minutes: number, onMinute?: (m: number) => Promise<void>) {
  for (let m = 0; m < minutes; m++) {
    await onMinute?.(m);
    for (let s = 0; s < 6; s++) {
      await page.evaluate(
        (n) => {
          const d = document.createElement("div");
          d.textContent = `tick ${n}`;
          document.body.appendChild(d);
        },
        m * 6 + s
      );
      await page.mouse.move(100 + s * 20, 200 + s * 10);
      await page.clock.fastForward(10_000);
    }
  }
  // One more event so the last checkout has something after the fast-forward.
  await page.mouse.move(10, 10);
}
