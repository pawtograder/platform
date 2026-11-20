/**
 * Where the rest of the app finds the running recorder, without importing rrweb.
 *
 * The review dialog asks `getActiveRecorder()` whether this report can carry a replay: with
 * the course flag off the recorder chunk never loads, and this returns undefined.
 * In E2E builds only, `window.__bugReportRecorder` mirrors the same value for the tests; it is
 * defined only while a recorder exists.
 */
import type { BugReportRecorder } from "./types";

declare global {
  interface Window {
    __bugReportRecorder?: BugReportRecorder;
  }
}

let active: BugReportRecorder | undefined;
const listeners = new Set<(recorder: BugReportRecorder | undefined) => void>();

export function getActiveRecorder(): BugReportRecorder | undefined {
  return active;
}

/** Called by the recorder on start and stop. */
export function setActiveRecorder(recorder: BugReportRecorder | undefined): void {
  active = recorder;
  // `process.env.BUG_REPORT_E2E` is a build-time constant (next.config.ts), so outside E2E builds
  // this folds away and page scripts and extensions can't reach the recorder's buffer.
  if (process.env.BUG_REPORT_E2E === "true" && typeof window !== "undefined") {
    if (recorder) window.__bugReportRecorder = recorder;
    else delete window.__bugReportRecorder;
  }
  for (const listener of listeners) listener(recorder);
}

/** Subscribe to recorder start and stop. Returns the unsubscribe function. */
export function subscribeActiveRecorder(listener: (recorder: BugReportRecorder | undefined) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
