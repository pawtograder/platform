/**
 * E2E-only entry point to the replay upload, until the review dialog's replay half (package
 * 5b) exists. `BugReportProvider` imports this only in builds made with E2E_ENABLE=true
 * (`process.env.BUG_REPORT_E2E`, inlined by next.config.ts); other builds compile the import
 * out.
 *
 * `window.__bugReportE2E.submitWithReplay` does what the dialog's Submit will do: freeze the
 * recorder's buffer and call the real `submitReport` with `uploadReplay` attached. It skips
 * the redaction pass (package 3) and the review step, so it must never exist in a build real
 * users load. Test data is synthetic, and the recorder already masks text at record time.
 */
import * as Sentry from "@sentry/nextjs";
import { getActiveRecorder } from "../activeRecorder";
import { submitReport, type SubmitReportResult } from "../submitFeedback";
import type { FrozenBuffer } from "../types";
import { createReplayUpload, type UploadResult, type UploadStats } from "./uploadReplay";

export type E2ESubmitInput = { description: string; contactOk?: boolean; eventId?: string };

export type E2ESubmitOutput = {
  result: SubmitReportResult;
  upload?: UploadResult;
  stats?: UploadStats;
  replayId: string;
  /** What the frozen buffer held. */
  buffer: Pick<FrozenBuffer, "startTimestamp" | "endTimestamp" | "size" | "urls" | "errorIds" | "traceIds"> & {
    checkouts: number;
    events: number;
  };
  /** Wall-clock ms from Submit to the feedback's answer (performance.now, unaffected by page.clock). */
  totalMs: number;
};

declare global {
  interface Window {
    __bugReportE2E?: {
      submitWithReplay(input: E2ESubmitInput): Promise<E2ESubmitOutput>;
      /**
       * `Sentry.sendFeedback` as a third party would call it, default options (so
       * `includeReplay: true`). Test B4 checks it carries no replay.
       */
      sendFeedback(message: string): Promise<string>;
    };
  }
}

export function installUploadTestHook(): void {
  if (typeof window === "undefined") return;
  window.__bugReportE2E = {
    sendFeedback: (message) => Sentry.sendFeedback({ message }),
    async submitWithReplay(input) {
      const recorder = getActiveRecorder();
      if (!recorder) throw new Error("no recorder running");
      const t0 = performance.now();
      const buffer = recorder.freeze();
      let stats: UploadStats | undefined;
      let upload: UploadResult | undefined;
      const inner = createReplayUpload(buffer, { onStats: (s) => (stats = s) });
      const result = await submitReport({
        description: input.description,
        contactOk: input.contactOk ?? false,
        eventId: input.eventId,
        replay: {
          upload: async (tags) => {
            upload = await inner.upload(tags);
            return upload;
          }
        }
      });
      return {
        result,
        upload,
        stats,
        replayId: buffer.replayId,
        buffer: {
          startTimestamp: buffer.startTimestamp,
          endTimestamp: buffer.endTimestamp,
          size: buffer.size,
          urls: buffer.urls,
          errorIds: buffer.errorIds,
          traceIds: buffer.traceIds,
          checkouts: buffer.segments.length,
          events: buffer.segments.reduce((n, s) => n + s.events.length, 0)
        },
        totalMs: performance.now() - t0
      };
    }
  };
}
