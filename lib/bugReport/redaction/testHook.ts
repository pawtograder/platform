/**
 * E2E-only hook for the leak tests (D tests): `window.__bugReportRedaction`. It freezes the
 * running recorder, redacts the copy in the worker, and returns what the report would upload.
 *
 * Loaded only from `lib/bugReport/recorder.ts` inside `process.env.BUG_REPORT_E2E === "true"`,
 * a build-time constant (next.config.ts), so production bundles never contain it.
 */
import { getActiveRecorder } from "../activeRecorder";
import { buildReportTags } from "../submitFeedback";
import { redactBuffer, taintSnapshot, type RedactionResult } from "./index";
import { redactReportUrl } from "./reportUrl";

export type RedactionTestOptions = { extraRedactions?: string[]; keepLastMs?: number; description?: string };

export type RedactionTestHook = {
  /** Freeze and redact; the full result, for assertions on `remaining` and `stats`. */
  redact(
    options?: RedactionTestOptions
  ): Promise<RedactionResult & { worker: boolean; freezeMs: number; totalMs: number; events: number }>;
  /**
   * The bytes a report would upload, as a JSON string: the redacted events, the replay event
   * fields that come from the buffer, and the feedback payload.
   */
  uploadJson(options?: RedactionTestOptions): Promise<string>;
  /** Timings and sizes only, for measurements on big buffers. */
  measure(options?: RedactionTestOptions): Promise<RedactionMeasurement>;
};

export type RedactionMeasurement = {
  stats: RedactionResult["stats"];
  freezeMs: number;
  /** Freeze, post to the worker, redact, and receive the result. */
  totalMs: number;
  events: number;
  segments: number;
  /** Characters of event JSON in the redacted buffer. */
  size: number;
  remaining: number;
  worker: boolean;
};

declare global {
  interface Window {
    __bugReportRedaction?: RedactionTestHook;
  }
}

async function redact(options: RedactionTestOptions = {}) {
  const recorder = getActiveRecorder();
  if (!recorder) throw new Error("no recorder running");
  const t0 = performance.now();
  const frozen = recorder.freeze();
  const freezeMs = performance.now() - t0;
  const result = await redactBuffer(frozen, {
    taintPatterns: taintSnapshot(),
    extraRedactions: options.extraRedactions,
    keepLastMs: options.keepLastMs
  });
  const totalMs = performance.now() - t0;
  const events = result.buffer.segments.reduce((n, s) => n + s.events.length, 0);
  return { ...result, worker: typeof Worker !== "undefined", freezeMs, totalMs, events };
}

export function installRedactionTestHook(): void {
  window.__bugReportRedaction = {
    redact,
    async measure(options = {}) {
      const r = await redact(options);
      return {
        stats: r.stats,
        freezeMs: r.freezeMs,
        totalMs: r.totalMs,
        events: r.events,
        segments: r.buffer.segments.length,
        size: r.buffer.size,
        remaining: r.remaining.length,
        worker: r.worker
      };
    },
    async uploadJson(options = {}) {
      const { buffer } = await redact(options);
      return JSON.stringify({
        replay_event: {
          replay_id: buffer.replayId,
          urls: buffer.urls,
          error_ids: buffer.errorIds,
          trace_ids: buffer.traceIds
        },
        recording: buffer.segments.map((s) => s.events),
        feedback: {
          message: options.description ?? "Something went wrong",
          url: redactReportUrl(window.location.href, undefined, options.extraRedactions),
          tags: buildReportTags({ contactOk: false })
        }
      });
    }
  };
}
