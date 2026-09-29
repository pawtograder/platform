/**
 * Report helpers for the leak tests (D tests), per the supervisor's contract.
 *
 * - `redactedUploadBytes(page)`: until the review dialog has a replay (package 5b) and the
 *   upload exists (package 6), this is what a D test scans. In the page it freezes the running
 *   recorder, redacts the copy in the redaction worker with this page load's taint set, and
 *   returns the would-be upload as JSON bytes: the redacted events, the replay event's URLs and
 *   ids, and the feedback payload (message, redacted page URL, tags). It needs a build made
 *   with E2E_ENABLE=true, which is the only kind that has `window.__bugReportRedaction`.
 * - `submitReportAndCapture(page, capture, ...)`: drives the real dialog from the user menu,
 *   including the replay review (click-to-redact, keep-last-N), and returns every byte the
 *   tunnel captured.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { RedactionResult } from "@/lib/bugReport/redaction";
import type { RedactionTestOptions } from "@/lib/bugReport/redaction/testHook";
import type { TunnelCapture } from "./tunnel";

export type { RedactionTestOptions };

// Polling with page.evaluate, not page.waitForFunction: waitForFunction evaluates a string in
// the page, which the app's CSP reports as a script-src eval violation, and the leak tests
// assert that there are none.
async function waitForHook(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__bugReportRedaction !== undefined), { timeout: 20_000 })
    .toBe(true);
}

/** Waits until the recorder is recording, without page.waitForFunction (see above). */
export async function waitForRecording(page: Page, timeout = 20_000): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__bugReportRecorder?.getState()), { timeout }).toBe("recording");
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

/** Opens "Report a bug" from the user menu with the pointer and returns the dialog. */
export async function openReportDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Support & Documentation" }).click();
  await page.getByRole("menuitem", { name: "Report a bug" }).click();
  const dialog = page.getByRole("dialog", { name: "Report a bug" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The review section of an open dialog (present only while a recording is attached). */
export function replayReview(dialog: Locator): Locator {
  return dialog.getByTestId("report-bug-replay-review");
}

/**
 * Waits until the review has redacted the recording and the preview shows its first frame:
 * no pass in flight, and the player ready.
 */
export async function waitForReviewReady(dialog: Locator, timeout = 60_000): Promise<void> {
  const review = replayReview(dialog);
  await expect(review).toHaveAttribute("data-status", "ready", { timeout });
  await expect(dialog.getByTestId("report-bug-replay-player")).toHaveAttribute("data-ready", "true", { timeout });
}

/** The remaining-strings list items as `{kind, value}`, in display order. */
export async function remainingStrings(dialog: Locator): Promise<{ kind: string; value: string }[]> {
  return dialog
    .getByTestId("report-bug-remaining")
    .locator("section[data-kind]")
    .evaluateAll((sections) =>
      sections.flatMap((section) =>
        Array.from(section.querySelectorAll("[data-value]")).map((el) => ({
          kind: section.getAttribute("data-kind") ?? "",
          value: el.textContent ?? ""
        }))
      )
    );
}

/** Text of the document the preview player rebuilt (its sandboxed iframe), or null before it has one. */
export async function previewText(dialog: Locator): Promise<string | null> {
  return dialog.getByTestId("report-bug-replay-player").evaluate((el) => {
    const doc = el.querySelector("iframe")?.contentDocument;
    return doc?.documentElement ? (doc.documentElement.textContent ?? "") : null;
  });
}

/**
 * Clicks Redact on every listed occurrence of `value` (it can appear under several kinds) and
 * waits for the re-run to finish without it.
 */
export async function redactInReview(dialog: Locator, value: string): Promise<void> {
  const items = dialog.getByTestId("report-bug-remaining-item").filter({
    has: dialog.page().locator("[data-value]", { hasText: new RegExp(`^${escapeRegExp(value)}$`) })
  });
  await expect(items.first()).toBeVisible();
  while ((await items.count()) > 0) {
    await items
      .first()
      .getByRole("button", { name: /^Redact / })
      .click();
  }
  await waitForReviewReady(dialog);
  expect((await remainingStrings(dialog)).map((r) => r.value)).not.toContain(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Files a report through the real dialog, opened from the user menu, and returns every byte the
 * tunnel captured (the inflated recording, the replay events, the feedback). With a recording
 * running, it waits for the review, applies `redact` (click-to-redact, each string) and
 * `keepLastMinutes`, and submits the redacted replay; without one it files feedback only.
 *
 * A test that installed `page.clock` must let time flow (the default after `install`, or
 * `resume()` after a pause): the dialog, the redaction worker, and the upload use timers.
 */
export async function submitReportAndCapture(
  page: Page,
  capture: TunnelCapture,
  options: { description?: string; redact?: string[]; keepLastMinutes?: number } = {}
): Promise<Uint8Array[]> {
  const dialog = await openReportDialog(page);
  await dialog.getByRole("textbox", { name: /What happened/ }).fill(options.description ?? "Something went wrong");
  const hasReplay = (await replayReview(dialog).count()) > 0;
  if (!hasReplay && (options.redact?.length || options.keepLastMinutes !== undefined)) {
    throw new Error("submitReportAndCapture: redact and keepLastMinutes need a running recording");
  }
  if (hasReplay) {
    await waitForReviewReady(dialog);
    if (options.keepLastMinutes !== undefined) {
      await dialog.getByTestId("report-bug-keep-minutes").selectOption(String(options.keepLastMinutes));
      await waitForReviewReady(dialog);
    }
    for (const value of options.redact ?? []) await redactInReview(dialog, value);
  }
  const feedbackBefore = capture.items("feedback").length;
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(dialog.getByTestId("report-bug-sent")).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => capture.items("feedback").length).toBeGreaterThan(feedbackBefore);
  return capture.uploadedBytes();
}
