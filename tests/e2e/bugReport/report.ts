/**
 * Report helpers for the leak tests (D tests), per the supervisor's contract.
 *
 * - `redactedUploadBytes(page)`: until the review dialog has a replay (package 5b) and the
 *   upload exists (package 6), this is what a D test scans. In the page it freezes the running
 *   recorder, redacts the copy in the redaction worker with this page load's taint set, and
 *   returns the would-be upload as JSON bytes: the redacted events, the replay event's URLs and
 *   ids, and the feedback payload (message, redacted page URL, tags). It needs a build made
 *   with E2E_ENABLE=true, which is the only kind that has `window.__bugReportRedaction`.
 * - `submitReportAndCapture(page, capture, ...)`: drives the real dialog from the user menu
 *   and returns every byte the tunnel captured. Replay-specific options (`redact`,
 *   `keepLastMinutes`) need package 5b's controls and throw until they exist.
 */
import { expect, type Page } from "@playwright/test";
import type { RedactionResult } from "@/lib/bugReport/redaction";
import type { RedactionTestOptions } from "@/lib/bugReport/redaction/testHook";
import type { TunnelCapture } from "./tunnel";

export type { RedactionTestOptions };

async function waitForHook(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__bugReportRedaction !== undefined, undefined, { timeout: 20_000 });
}

/** The would-be upload of a report made now, redacted, as UTF-8 JSON bytes. */
export async function redactedUploadBytes(page: Page, options: RedactionTestOptions = {}): Promise<Uint8Array> {
  await waitForHook(page);
  const json = await page.evaluate((o) => window.__bugReportRedaction!.uploadJson(o), options);
  return new TextEncoder().encode(json);
}

/** The full redaction result (buffer, remaining strings, stats) of a report made now. */
export async function redactedReport(
  page: Page,
  options: RedactionTestOptions = {}
): Promise<RedactionResult & { worker: boolean; freezeMs: number; totalMs: number; events: number }> {
  await waitForHook(page);
  return page.evaluate((o) => window.__bugReportRedaction!.redact(o), options);
}

export async function submitReportAndCapture(
  page: Page,
  capture: TunnelCapture,
  options: { description?: string; redact?: string[]; keepLastMinutes?: number } = {}
): Promise<Uint8Array[]> {
  if (options.redact?.length || options.keepLastMinutes !== undefined) {
    throw new Error("submitReportAndCapture: redact and keepLastMinutes need the replay review UI (package 5b)");
  }
  const before = capture.envelopes.length;
  await page.getByRole("button", { name: "Support & Documentation" }).click();
  await page.getByRole("menuitem", { name: "Report a bug" }).click();
  const dialog = page.getByRole("dialog", { name: "Report a bug" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: /What happened/ }).fill(options.description ?? "Something went wrong");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(dialog.getByTestId("report-bug-sent")).toBeVisible();
  await expect.poll(() => capture.envelopes.length).toBeGreaterThan(before);
  return capture.uploadedBytes();
}
