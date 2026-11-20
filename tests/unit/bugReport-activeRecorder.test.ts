/**
 * `window.__bugReportRecorder` exposes the recorder (and through `freeze()`, its buffer) to any
 * script on the page, so only E2E builds define it. The app itself reaches the recorder through
 * getActiveRecorder(), which works either way.
 */
import { getActiveRecorder, setActiveRecorder } from "@/lib/bugReport/activeRecorder";
import type { BugReportRecorder } from "@/lib/bugReport/types";

const recorder = { getState: () => "recording" } as unknown as BugReportRecorder;

afterEach(() => {
  setActiveRecorder(undefined);
  delete process.env.BUG_REPORT_E2E;
});

it("does not put the recorder on window outside E2E builds", () => {
  process.env.BUG_REPORT_E2E = "false";
  setActiveRecorder(recorder);
  expect(getActiveRecorder()).toBe(recorder);
  expect(window.__bugReportRecorder).toBeUndefined();
  expect("__bugReportRecorder" in window).toBe(false);
});

it("mirrors the recorder on window in E2E builds, and removes it on stop", () => {
  process.env.BUG_REPORT_E2E = "true";
  setActiveRecorder(recorder);
  expect(window.__bugReportRecorder).toBe(recorder);
  setActiveRecorder(undefined);
  expect(window.__bugReportRecorder).toBeUndefined();
});
