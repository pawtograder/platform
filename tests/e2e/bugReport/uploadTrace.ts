/**
 * Phase 2 of the taint trace (spec package 2a): run the recorder and the redaction in every traced
 * test, and scan each would-be upload for canaries.
 *
 * Active under `BUG_REPORT_TRACE=1` together with `BUG_REPORT_TRACE_UPLOAD=1` (the nightly workflow
 * sets both). For each browser context a test opens, `UploadScanner`:
 *
 * - turns the course flag on (service role) for every class the context navigates into, before
 *   the navigation's request goes out, so the page's own flag lookup already sees it;
 * - installs a test route policy (the E2E localStorage override) that lists every
 *   `/course/[course_id]/...` page at the level `traceLevelFor` gives it;
 * - before each `page.goto`/`page.reload` (a full load ends the page load's recording), before
 *   `page.close`/`context.close`, and at the end of the test, collects the would-be upload of each
 *   page with a running recorder through `redactedUploadBytes`' hook (freeze, then the redaction
 *   worker, plus the feedback payload), and runs `scanForCanaries` over it with every canary this
 *   worker seeded.
 *
 * Specs that manage recording themselves (they call `enableBugReports`/`enableRecording` or set the
 * flag; see `managesRecording`) keep their own flag and policy: the scanner only scans their pages.
 * Pages outside a course, and pages whose course never turned recording on, are counted as skipped;
 * the recorder is course-scoped and has nothing to upload there.
 *
 * With `BUG_REPORT_TRACE_STRICT=1`, a test with hits fails at teardown, naming each canary, its
 * column, the route, and where in the upload it was found.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { ROUTE_POLICY, type RecordingLevel, type RoutePolicyEntry } from "@/lib/bugReport/routePolicy";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { normalizeForMatch, variants } from "@/lib/bugReport/variants";
import { isNumberFragment, scanForCanaries, type CanaryHit, type VariantsOf } from "./canaries";
import {
  isTraceMode,
  TOKEN_PATTERN_SOURCE,
  workerCanaries,
  type CanaryEntry,
  type CanaryRegistry
} from "./canaryRegistry";
import { allRoutePatterns, routePatternFor } from "./routePatterns";

export function isUploadTraceMode(): boolean {
  return isTraceMode() && process.env.BUG_REPORT_TRACE_UPLOAD === "1";
}

const TEST_ROUTE_POLICY_KEY = "bugReport.testRoutePolicy";

/** First path segment after `/course/[course_id]` of pages that show a whole class. */
const CLASS_WIDE_SECTIONS = new Set(["manage", "grade", "discussion", "office-hours", "polls", "regrade-requests"]);

/**
 * The level a trace run records a course page at. A page listed in `ROUTE_POLICY` gets its
 * listed level. Otherwise the rule is: staff areas (`manage/*`, the grading views under `grade/`)
 * and pages that list other people's posts, requests, or answers (discussion, office hours, polls,
 * regrade requests) are `structure`; everything else under a course is a page about the viewer's
 * own work (assignments, submissions, gradebook, surveys, flashcards, notifications, the course
 * home) and is `full`.
 */
export function traceLevelFor(pattern: string): RecordingLevel {
  const listed = ROUTE_POLICY.find((e) => e.pattern === pattern);
  if (listed) return listed.level;
  const section = pattern.split("/")[3];
  return section !== undefined && CLASS_WIDE_SECTIONS.has(section) ? "structure" : "full";
}

/** Course pages left out of the trace policy: test harness pages feed canaries in on purpose. */
function isHarness(pattern: string): boolean {
  return pattern.split("/").includes("e2e-harness");
}

/** The test route policy for a trace run: every course page, at `traceLevelFor`. */
export function traceRoutePolicy(): RoutePolicyEntry[] {
  return allRoutePatterns()
    .filter((p) => p.startsWith("/course/[course_id]") && !isHarness(p))
    .map((pattern) => ({ pattern, level: traceLevelFor(pattern) }));
}

const managedCache = new Map<string, boolean>();

/**
 * True when a spec controls the course flag and route policy itself, so the trace must leave them
 * alone: the bug reporter's own specs under `tests/e2e/bugReport/` (several assert what happens
 * with the flag off or a route unlisted), except the trace tour, and any other spec that turns
 * recording on.
 */
export function managesRecording(specFile: string): boolean {
  let managed = managedCache.get(specFile);
  if (managed === undefined) {
    const own = /\/tests\/e2e\/bugReport\//.test(specFile) && !/trace-tour\.spec\.ts$/.test(specFile);
    let source = "";
    try {
      source = readFileSync(specFile, "utf8");
    } catch {
      /* unknown file: treat as not managing */
    }
    managed = own || /\benableBugReports\b|\benableRecording\b|BUG_REPORT_RECORDING|bug-report-recording/.test(source);
    managedCache.set(specFile, managed);
  }
  return managed;
}

/** Where in the upload a canary was found. */
export type UploadHit = {
  test: string;
  canary: string;
  kind: string;
  column: string;
  rowId: string | number;
  /** The variant of the canary that matched */
  matched: string;
  /** Route of the page when the upload was collected */
  route: string;
  /** Route of the recording's last checkout (Meta event) before the hit, when the hit is in an event */
  recordedRoute: string | null;
  /** e.g. "FullSnapshot text node #12 in <span>", "Mutation attribute #40 <a> [title]", "feedback.url" */
  where: string;
  /** When the scan ran: "test end", "before goto", "before page.close", ... */
  at: string;
  context: string;
};

export type SkippedPage = { test: string; route: string; at: string; reason: string };

export type UploadTracePartial = {
  tests: string[];
  uploadsScanned: number;
  /** Bytes of upload JSON scanned */
  bytesScanned: number;
  hits: UploadHit[];
  /** Pages that had a recorder but could not be scanned, and why */
  unscannable: SkippedPage[];
  /** Pages with nothing to upload (no course, recording off), counted by reason */
  skipped: Record<string, number>;
  /** Routes of course pages with no recorder running, counted */
  noRecorderRoutes: Record<string, number>;
  /**
   * Uploads whose page showed at least one canary when the upload was collected, by route: the
   * scans where redaction had something to remove.
   */
  withCanariesOnPage: Record<string, number>;
  /** Classes whose flag the trace turned on */
  classesEnabled: number;
};

const EVENT_TYPES: Record<number, string> = {
  0: "DomContentLoaded",
  1: "Load",
  2: "FullSnapshot",
  3: "IncrementalSnapshot",
  4: "Meta",
  5: "Custom",
  6: "Plugin"
};
const INCREMENTAL_SOURCES: Record<number, string> = {
  0: "Mutation",
  1: "MouseMove",
  2: "MouseInteraction",
  3: "Scroll",
  4: "ViewportResize",
  5: "Input",
  6: "TouchMove",
  7: "MediaInteraction",
  8: "StyleSheetRule",
  9: "CanvasMutation",
  10: "Font",
  11: "Log",
  12: "Drag",
  13: "StyleDeclaration",
  14: "Selection",
  15: "AdoptedStyleSheet",
  16: "CustomElement"
};

/** One string of the upload, where it sits, and whether it is stylesheet text. */
export type Leaf = { value: string; where: string; recordedRoute: string | null; css?: boolean };

type SNode = {
  id?: number;
  type?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SNode[];
  textContent?: string;
  isStyle?: boolean;
};

/** rrweb sources whose payload is CSS */
const CSS_SOURCES = new Set([8, 13, 15]);
const CSS_ATTRIBUTES = new Set(["_cssText", "style"]);

function routeOfHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  try {
    return routePatternFor(new URL(href).pathname);
  } catch {
    return null;
  }
}

function genericLeaves(value: unknown, where: string, route: string | null, out: Leaf[], css = false) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") out.push({ value, where, recordedRoute: route, css });
  else if (typeof value === "number") out.push({ value: String(value), where, recordedRoute: route, css });
  else if (Array.isArray(value)) value.forEach((v, i) => genericLeaves(v, `${where}[${i}]`, route, out, css));
  else if (typeof value === "object")
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      genericLeaves(v, where ? `${where}.${k}` : k, route, out, css);
}

function nodeLeaves(node: SNode | undefined, prefix: string, parentTag: string, route: string | null, out: Leaf[]) {
  if (!node || typeof node !== "object") return;
  const id = node.id ?? "?";
  if (typeof node.textContent === "string")
    out.push({
      value: node.textContent,
      where: `${prefix} ${node.isStyle ? "style text" : "text node"} #${id} in <${parentTag}>`,
      recordedRoute: route,
      css: node.isStyle === true || parentTag === "style"
    });
  const tag = node.tagName ?? parentTag;
  for (const [name, v] of Object.entries(node.attributes ?? {})) {
    if (typeof v === "string")
      out.push({
        value: v,
        where: `${prefix} node #${id} <${tag}> [${name}]`,
        recordedRoute: route,
        css: CSS_ATTRIBUTES.has(name)
      });
  }
  for (const child of node.childNodes ?? []) nodeLeaves(child, prefix, tag, route, out);
}

/** Every string in the upload JSON, with a description of where it sits. */
export function uploadLeaves(upload: { replay_event?: unknown; recording?: unknown[][]; feedback?: unknown }): Leaf[] {
  const out: Leaf[] = [];
  genericLeaves(upload.replay_event, "replay_event", null, out);
  genericLeaves(upload.feedback, "feedback", null, out);
  (upload.recording ?? []).forEach((segment, s) => {
    let route: string | null = null;
    (segment ?? []).forEach((raw, i) => {
      const e = raw as { type?: number; data?: Record<string, unknown> };
      const data = e.data ?? {};
      const typeName = EVENT_TYPES[e.type ?? -1] ?? `type ${e.type}`;
      const at = `segment ${s} event ${i}`;
      if (e.type === 4) {
        route = routeOfHref(data.href) ?? route;
        genericLeaves(data, `${at} Meta`, route, out);
      } else if (e.type === 2) {
        nodeLeaves(data.node as SNode, `${at} FullSnapshot`, "document", route, out);
      } else if (e.type === 3) {
        const source = INCREMENTAL_SOURCES[data.source as number] ?? `source ${String(data.source)}`;
        if (data.source === 0) {
          for (const t of (data.texts as { id?: number; value?: unknown }[]) ?? [])
            if (typeof t.value === "string")
              out.push({ value: t.value, where: `${at} Mutation text #${t.id}`, recordedRoute: route });
          for (const a of (data.attributes as { id?: number; attributes?: Record<string, unknown> }[]) ?? [])
            for (const [name, v] of Object.entries(a.attributes ?? {}))
              genericLeaves(v, `${at} Mutation attribute #${a.id} [${name}]`, route, out, CSS_ATTRIBUTES.has(name));
          for (const add of (data.adds as { parentId?: number; node?: SNode }[]) ?? [])
            nodeLeaves(add.node, `${at} Mutation add (parent #${add.parentId})`, "?", route, out);
        } else if (data.source === 5) {
          genericLeaves(data.text, `${at} Input #${String(data.id)}`, route, out);
        } else {
          genericLeaves(data, `${at} ${source}`, route, out, CSS_SOURCES.has(data.source as number));
        }
      } else if (e.type === 5) {
        const tag = typeof data.tag === "string" ? data.tag : "custom";
        const payload = data.payload as { category?: string } | undefined;
        const label = payload?.category ? `${tag} ${payload.category}` : tag;
        genericLeaves(payload, `${at} Custom ${label}`, route, out);
      } else {
        genericLeaves(data, `${at} ${typeName}`, route, out);
      }
    });
  });
  return out;
}

/**
 * The forms of each canary the upload scan looks for. A generated canary's variants that contain
 * one of its invented anchor tokens: "Last, First", the first and last tokens, and the
 * `name (real_name)` form, but not the tokens of a real name or of words around the anchor
 * ("Student", "One", "Commit"), which are everywhere in a page. A value a spec chose itself
 * ("Grade View Student") is matched only whole, the way the trace's own matcher treats it.
 */
export const uploadVariants: VariantsOf = (canary, entry) => {
  const anchors = (entry as CanaryEntry).anchors;
  if (!anchors?.length) return [normalizeForMatch(canary)];
  const tokenRe = new RegExp(TOKEN_PATTERN_SOURCE, "gu");
  return variants(canary, { kind: entry.kind, realName: entry.realName }).filter((v) =>
    [...v.matchAll(tokenRe)].some((m) => anchors.includes(m[0]))
  );
};

/**
 * Canary hits in one upload, each with the string it sits in. A grade canary inside a longer
 * number or inside stylesheet text (a font metric such as "ascent-override: 94.56%") is a
 * coincidence, not a grade, and is dropped. Hits the per-string pass can't place (the upload was
 * not JSON) are kept with their offset.
 */
export function findUploadHits(json: string, registry: CanaryRegistry): { hit: CanaryHit; leaf: Leaf }[] {
  const raw = scanForCanaries(json, registry, uploadVariants).filter((h) => !isNumberFragment(json, h));
  if (raw.length === 0) return [];
  let leaves: Leaf[];
  try {
    leaves = uploadLeaves(JSON.parse(json));
  } catch {
    return raw.map((hit) => ({ hit, leaf: { value: "", where: `(offset ${hit.offset})`, recordedRoute: null } }));
  }
  const out: { hit: CanaryHit; leaf: Leaf }[] = [];
  for (const leaf of leaves) {
    // One hit per canary per string: the longest variant that matched ("Jane Doe" over "Jane").
    const best = new Map<string, CanaryHit>();
    for (const hit of scanForCanaries(leaf.value, registry, uploadVariants)) {
      if (isNumberFragment(leaf.value, hit)) continue;
      if (hit.entry.kind === "grade" && leaf.css) continue;
      const prior = best.get(hit.canary);
      if (!prior || hit.matched.length > prior.matched.length) best.set(hit.canary, hit);
    }
    for (const hit of best.values()) out.push({ hit, leaf });
  }
  return out;
}

type PageState = { course: boolean; recorder: string | null; hook: boolean };

const SCAN_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    })
  ]);
}

function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0].slice(0, 200);
}

export type UploadScannerOptions = { registry?: CanaryRegistry };

/**
 * Runs phase 2 for the contexts the worker's tracer attaches. One per worker (`workerUploadScanner`
 * in `traceFixture.ts`).
 */
export class UploadScanner {
  currentTest = "(no test)";
  private readonly registry: CanaryRegistry;
  private readonly contexts = new Set<BrowserContext>();
  private readonly attached = new WeakSet<BrowserContext>();
  private readonly patchedPages = new WeakSet<Page>();
  private readonly enabledClasses = new Set<number>();
  private readonly failedClasses = new Set<number>();
  private readonly enabling = new Map<number, Promise<void>>();
  private readonly tests = new Set<string>();
  private readonly hits: UploadHit[] = [];
  private readonly hitKeys = new Set<string>();
  private readonly unscannable: SkippedPage[] = [];
  private readonly skipped: Record<string, number> = {};
  private readonly noRecorderRoutes: Record<string, number> = {};
  private readonly withCanariesOnPage: Record<string, number> = {};
  private uploadsScanned = 0;
  private bytesScanned = 0;

  constructor(options: UploadScannerOptions = {}) {
    this.registry = options.registry ?? workerCanaries;
  }

  /**
   * Starts phase 2 for `context`. `manage` false leaves the flag and policy to the spec (see
   * `managesRecording`); its pages are still scanned.
   */
  async attachContext(context: BrowserContext, { manage }: { manage: boolean }): Promise<void> {
    if (this.attached.has(context)) return;
    this.attached.add(context);
    this.contexts.add(context);
    context.on("close", () => this.contexts.delete(context));
    if (manage) {
      await context.addInitScript(
        ([key, value]) => {
          try {
            window.localStorage.setItem(key, value);
          } catch {
            // about:blank and opaque origins have no localStorage.
          }
        },
        [TEST_ROUTE_POLICY_KEY, JSON.stringify(traceRoutePolicy())] as const
      );
      // Before the request for a course page goes out, turn the course's flag on, so the page's
      // own flag lookup (BugReportRecorder) already sees it. `fallback` leaves the request to any
      // other handler the test installed.
      await context.route(
        (url) => /^\/course\/\d+(\/|$)/.test(url.pathname),
        async (route) => {
          const m = /^\/course\/(\d+)/.exec(new URL(route.request().url()).pathname);
          if (m) await this.enableClass(Number(m[1]));
          await route.fallback();
        }
      );
    }
    for (const page of context.pages()) this.attachPage(page);
    context.on("page", (page) => this.attachPage(page));
    const close = context.close.bind(context);
    context.close = async (...args: Parameters<BrowserContext["close"]>) => {
      await this.scanContext(context, "before context.close");
      return close(...args);
    };
  }

  private async enableClass(classId: number): Promise<void> {
    if (this.enabledClasses.has(classId) || this.failedClasses.has(classId)) return;
    let pending = this.enabling.get(classId);
    if (!pending) {
      // Imported on use: TestingUtils builds a service-role client, which the unit tests of this
      // module have no environment for.
      pending = import("../TestingUtils")
        .then(({ setCourseFeature }) => setCourseFeature(classId, COURSE_FEATURES.BUG_REPORT_RECORDING, true))
        .then(() => {
          this.enabledClasses.add(classId);
        })
        .catch((e) => {
          // A class another worker deleted, or a transient error: that class just won't record.
          this.failedClasses.add(classId);
          process.stderr.write(`[bug-report-trace] could not turn recording on for class ${classId}: ${e}\n`);
        })
        .finally(() => this.enabling.delete(classId));
      this.enabling.set(classId, pending);
    }
    await pending;
  }

  private attachPage(page: Page) {
    if (this.patchedPages.has(page)) return;
    this.patchedPages.add(page);
    const goto = page.goto.bind(page);
    page.goto = async (...args: Parameters<Page["goto"]>) => {
      await this.scanPage(page, "before goto");
      return goto(...args);
    };
    const reload = page.reload.bind(page);
    page.reload = async (...args: Parameters<Page["reload"]>) => {
      await this.scanPage(page, "before reload");
      return reload(...args);
    };
    const close = page.close.bind(page);
    page.close = async (...args: Parameters<Page["close"]>) => {
      await this.scanPage(page, "before page.close");
      return close(...args);
    };
  }

  /** Scans every open page in every live context. Called at the end of each test. */
  async scanAll(at: string): Promise<void> {
    for (const context of [...this.contexts]) await this.scanContext(context, at);
  }

  private async scanContext(context: BrowserContext, at: string): Promise<void> {
    let pages: Page[] = [];
    try {
      pages = context.pages();
    } catch {
      return;
    }
    for (const page of pages) await this.scanPage(page, at);
  }

  private skip(reason: string) {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
  }

  private cannotScan(route: string, at: string, reason: string) {
    this.unscannable.push({ test: this.currentTest, route, at, reason });
  }

  /** Collects and scans the would-be upload of `page`, if a recorder is running there. */
  async scanPage(page: Page, at: string): Promise<void> {
    this.tests.add(this.currentTest);
    if (page.isClosed()) return;
    let url: URL;
    try {
      url = new URL(page.url());
    } catch {
      this.skip("no page loaded");
      return;
    }
    if (!/^https?:$/.test(url.protocol)) {
      this.skip("no page loaded");
      return;
    }
    const route = routePatternFor(url.pathname);
    if (!/^\/course\/\d+(\/|$)/.test(url.pathname)) {
      this.skip("not a course page (the recorder is course-scoped)");
      return;
    }
    if (isHarness(route)) {
      this.skip("test harness page");
      return;
    }
    let state: PageState | null = null;
    for (let attempt = 0; attempt < 2 && state === null; attempt++) {
      try {
        state = await withTimeout(
          page.evaluate(() => ({
            course: true,
            recorder: window.__bugReportRecorder?.getState() ?? null,
            hook: window.__bugReportRedaction !== undefined
          })),
          10_000,
          "recorder state"
        );
      } catch (e) {
        if (page.isClosed()) return;
        if (attempt === 1) {
          this.cannotScan(route, at, `could not read the recorder state: ${shortError(e)}`);
          return;
        }
        // A navigation replaced the document mid-evaluate; wait for the new one and retry.
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      }
    }
    if (!state) return;
    if (state.recorder === null || state.recorder === "stopped") {
      this.skip("no recorder running (course flag off or route not recorded)");
      this.noRecorderRoutes[route] = (this.noRecorderRoutes[route] ?? 0) + 1;
      return;
    }
    if (!state.hook) {
      // The hook loads right after the recorder starts; give it a moment before calling it missing.
      // Polled from Node: the page's timers may be a test's fake clock.
      let hook = false;
      for (let i = 0; i < 25 && !hook && !page.isClosed(); i++) {
        await new Promise((r) => setTimeout(r, 200));
        hook = await page.evaluate(() => window.__bugReportRedaction !== undefined).catch(() => false);
      }
      if (!hook) {
        this.cannotScan(route, at, "recorder running but no redaction hook (a build without E2E_ENABLE=true?)");
        return;
      }
    }
    let json: string;
    try {
      json = await withTimeout(
        page.evaluate(() => window.__bugReportRedaction!.uploadJson()),
        SCAN_TIMEOUT_MS,
        "freeze and redact"
      );
    } catch (e) {
      if (page.isClosed()) {
        this.cannotScan(route, at, "page closed while the upload was being collected");
        return;
      }
      this.cannotScan(route, at, `could not collect the upload: ${shortError(e)}`);
      return;
    }
    this.uploadsScanned++;
    this.bytesScanned += json.length;
    const shown = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (scanForCanaries(shown, this.registry, uploadVariants).length > 0)
      this.withCanariesOnPage[route] = (this.withCanariesOnPage[route] ?? 0) + 1;
    for (const { hit, leaf } of findUploadHits(json, this.registry)) {
      const key = [hit.canary, hit.matched, route, leaf.where.replace(/^segment \d+ event \d+ /, "")].join("\u0000");
      if (this.hitKeys.has(`${this.currentTest}\u0000${key}`)) continue;
      this.hitKeys.add(`${this.currentTest}\u0000${key}`);
      this.hits.push({
        test: this.currentTest,
        canary: hit.canary,
        kind: hit.entry.kind,
        column: hit.entry.column,
        rowId: hit.entry.rowId,
        matched: hit.matched,
        route,
        recordedRoute: leaf.recordedRoute,
        where: leaf.where,
        at,
        context: hit.context
      });
    }
  }

  hitsFor(test: string): UploadHit[] {
    return this.hits.filter((h) => h.test === test);
  }

  partial(): UploadTracePartial {
    return {
      tests: [...this.tests],
      uploadsScanned: this.uploadsScanned,
      bytesScanned: this.bytesScanned,
      hits: this.hits,
      unscannable: this.unscannable,
      skipped: this.skipped,
      noRecorderRoutes: this.noRecorderRoutes,
      withCanariesOnPage: this.withCanariesOnPage,
      classesEnabled: this.enabledClasses.size
    };
  }
}

/** One line per hit, for a strict-mode failure. */
export function describeUploadHits(hits: UploadHit[]): string {
  return hits
    .map(
      (h) =>
        `"${h.matched}" (${h.kind} canary from ${h.column}#${h.rowId}) on ${h.route}` +
        `${h.recordedRoute && h.recordedRoute !== h.route ? ` (recorded on ${h.recordedRoute})` : ""}` +
        ` at ${h.where} [${h.at}]`
    )
    .join("\n");
}
