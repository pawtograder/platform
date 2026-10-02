/**
 * Helpers for the recorder specs (package 1): turning recording on for a class, reading the
 * running recorder through `window.__bugReportRecorder`, and walking recorded rrweb events.
 */
import type { Page, Response } from "@playwright/test";
import { expect } from "@playwright/test";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import type { RoutePolicyEntry } from "@/lib/bugReport/routePolicy";
import type { FrozenBuffer, RecordedEvent } from "@/lib/bugReport/types";
import { setCourseFeature } from "../TestingUtils";

export const TEST_ROUTE_POLICY_KEY = "bugReport.testRoutePolicy";

/**
 * Turn the course flag on and, when given, install a test route policy before any page script
 * runs. The policy is honored only by builds made with E2E_ENABLE=true.
 */
export async function enableRecording(page: Page, classId: number, policy?: RoutePolicyEntry[]): Promise<void> {
  await setCourseFeature(classId, COURSE_FEATURES.BUG_REPORT_RECORDING, true);
  if (policy) await setTestRoutePolicy(page, policy);
}

/** The spec §7.2 name for `enableRecording`: course flag on, and the test route policy if given. */
export const enableBugReports = enableRecording;

export async function setTestRoutePolicy(page: Page, policy: RoutePolicyEntry[]): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [TEST_ROUTE_POLICY_KEY, JSON.stringify(policy)] as const
  );
}

export async function waitForRecorderState(page: Page, state: "recording" | "paused", timeout = 20_000) {
  await page.waitForFunction((s) => window.__bugReportRecorder?.getState() === s, state, { timeout });
}

export async function recorderDefined(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__bugReportRecorder !== undefined);
}

export async function freeze(page: Page): Promise<FrozenBuffer> {
  return page.evaluate(() => {
    const r = window.__bugReportRecorder;
    if (!r) throw new Error("no recorder");
    return r.freeze();
  });
}

export type RecorderStats = { size: number; segments: number; events: number; totalPushed: number };

export async function recorderStats(page: Page): Promise<RecorderStats> {
  return page.evaluate(() => {
    const r = window.__bugReportRecorder as unknown as { stats(): RecorderStats } | undefined;
    if (!r) throw new Error("no recorder");
    return r.stats();
  });
}

export function allEvents(buffer: FrozenBuffer): RecordedEvent[] {
  return buffer.segments.flatMap((s) => s.events);
}

/** A serialized rrweb node (rrweb-snapshot `serializedNode` with an id), loosely typed. */
export type SerializedNode = {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, string | number | boolean | null>;
  childNodes?: SerializedNode[];
  textContent?: string;
  isStyle?: boolean;
};

function walk(node: SerializedNode, out: SerializedNode[]): void {
  out.push(node);
  for (const child of node.childNodes ?? []) walk(child, out);
}

/** Every node in every FullSnapshot and every mutation `adds` entry. */
export function allSerializedNodes(buffer: FrozenBuffer): SerializedNode[] {
  const out: SerializedNode[] = [];
  for (const e of allEvents(buffer)) {
    const data = e.data as { node?: SerializedNode; source?: number; adds?: { node: SerializedNode }[] };
    if (e.type === 2 && data.node) walk(data.node, out);
    if (e.type === 3 && data.source === 0) for (const add of data.adds ?? []) walk(add.node, out);
  }
  return out;
}

/** Recorded text: text nodes (not stylesheet text) and mutation text changes. */
export function recordedTexts(buffer: FrozenBuffer): string[] {
  const texts: string[] = [];
  for (const node of allSerializedNodes(buffer)) {
    if (node.type === 3 && !node.isStyle && typeof node.textContent === "string") texts.push(node.textContent);
  }
  for (const e of allEvents(buffer)) {
    const data = e.data as { source?: number; texts?: { value: string | null }[] };
    if (e.type === 3 && data.source === 0) for (const t of data.texts ?? []) if (t.value) texts.push(t.value);
  }
  return texts;
}

/** True when every non-whitespace character is the mask character. */
export function isMasked(text: string): boolean {
  return /^[\s*]*$/.test(text);
}

export type Breadcrumb = { category: string; message?: string; level?: string; data?: Record<string, unknown> };

export function breadcrumbs(buffer: FrozenBuffer): Breadcrumb[] {
  return allEvents(buffer)
    .filter((e) => e.type === 5 && (e.data as { tag?: string }).tag === "breadcrumb")
    .map((e) => (e.data as { payload: Breadcrumb }).payload);
}

/**
 * Collects the JavaScript the page loads, so a test can say whether the recorder chunk was
 * ever requested. Webpack splits them: the recorder module is the only chunk containing
 * `RECORDER_CHUNK_MARKER` (from its block selector), and rrweb the only one with `RRWEB_MARKER`
 * (rrweb-snapshot; the app bundles no other rrweb copy since Sentry replay is not used).
 */
export const RECORDER_CHUNK_MARKER = "data-report-secret";
export const RRWEB_MARKER = "rr_mediaState";

export function collectScripts(page: Page): { urls: string[]; bodies: Promise<string>[] } {
  const collected = { urls: [] as string[], bodies: [] as Promise<string>[] };
  page.on("response", (response: Response) => {
    const url = response.url();
    if (!/\.js(\?|$)/.test(url)) return;
    collected.urls.push(url);
    collected.bodies.push(response.text().catch(() => ""));
  });
  return collected;
}

export async function recorderChunkRequested(collected: { bodies: Promise<string>[] }): Promise<boolean> {
  const bodies = await Promise.all(collected.bodies);
  return bodies.some((b) => b.includes(RECORDER_CHUNK_MARKER) || b.includes(RRWEB_MARKER));
}

/** Click a course nav link (a Next <Link>, so the navigation is client-side). */
export async function clickNavLink(page: Page, href: string): Promise<void> {
  const link = page.locator(`a[href="${href}"]`).filter({ visible: true }).first();
  await expect(link).toBeVisible();
  const before = await page.evaluate(() => performance.getEntriesByType("navigation").length);
  await link.click();
  await page.waitForURL((u) => u.pathname === href.replace(/\/$/, "") || u.pathname === href);
  // Still the same document: a client navigation, not a full load.
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(before);
}

/** Collects main-thread long tasks (> 50 ms) from page load on. Call before `goto`. */
export async function installLongTaskObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: { start: number; duration: number }[] };
    w.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // Not supported (WebKit); the caller skips.
    }
  });
}

export async function longTasks(page: Page): Promise<{ start: number; duration: number }[]> {
  return page.evaluate(
    () => (window as unknown as { __longTasks?: { start: number; duration: number }[] }).__longTasks ?? []
  );
}
