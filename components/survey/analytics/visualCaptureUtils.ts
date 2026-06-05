/** Shared helpers for Playwright / Argos visual-test capture behavior. */

export function isVisualTestMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-visual-tests");
}

/** True for Playwright WebKit / Safari — excludes Chromium, which also embeds AppleWebKit. */
export function isWebKitBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /AppleWebKit/i.test(ua) && !/Chrom(e|ium)/i.test(ua);
}

export function hasSurveyResponsesTable(): boolean {
  return typeof document !== "undefined" && document.querySelector("[data-survey-responses-table]") != null;
}

/**
 * Instructor survey responses pages mount SurveyAnalytics above a wide per-student
 * responses table. Full-page WebKit captures force synchronous layout/paint across
 * every simultaneously-mounted Recharts SVG; pairing the table with many chart hosts
 * crashes the browser during waitForVisualIdle. Chromium is unaffected — keep its
 * captures at full fidelity and only thin chart mounts on WebKit visual tests.
 */
export function shouldReduceSurveyChartMountCost(): boolean {
  return isVisualTestMode() && isWebKitBrowser() && hasSurveyResponsesTable();
}

/** Representative subset of scale-group charts to keep mounted on WebKit. */
export const WEBKIT_VISUAL_CAPTURE_MAX_SCALE_GROUPS = 2;

/** Per-group detail panel: one diverging/checkbox chart is enough for regression signal. */
export const WEBKIT_VISUAL_CAPTURE_MAX_GROUP_DETAIL_CHARTS = 1;
