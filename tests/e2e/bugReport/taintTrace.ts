/**
 * The taint trace (spec package 2a, phase 1): watches a browser context for canaries and records
 * where they arrive (sources) and where they render (sinks).
 *
 * Sources: every HTTP response the pages receive (PostgREST, RPC, edge functions, `/api/*`, RSC
 * payloads, and the `self.__next_f` chunks inside the initial HTML) and every realtime websocket
 * frame. Each hit is recorded with its source, the `table.column` or JSONPath that carried it, and
 * the canary's kind; `lib/bugReport/traceCheck.ts` then checks each one against `privacy.ts`.
 *
 * Sinks: an init script rescans the DOM (text, a few attributes, input values, the document title)
 * whenever it settles after a change, and reports each canary with the route, the nearest
 * `data-sentry-component`, and whether it sits inside `[data-report-unmask]` or
 * `[data-report-block]`. Component names need the full Sentry build profile: `ci-fast` turns the
 * annotation off, and every sink then reads "(unannotated)".
 */
import type { BrowserContext, Page, Response, WebSocket } from "@playwright/test";
import { parseSelect, resolveEmbed, type SelectTree } from "@/lib/bugReport/selectParser";
import { classifyResponse } from "@/lib/bugReport/selectParser";
import { RPCS } from "@/lib/bugReport/privacy";
import { isTableRef } from "@/lib/bugReport/privacyTypes";
import edgeWrappers from "@/lib/bugReport/generated/edgeFunctionWrappers.json";
import {
  normalizeObserved,
  normalizeSinks,
  sinkComponentKey,
  type ObservedFlow,
  type ObservedKind,
  type PiiSinks
} from "@/lib/bugReport/traceCheck";
import { normalizeForMatch } from "@/lib/bugReport/variants";
import {
  CanaryMatcher,
  TOKEN_PATTERN_SOURCE,
  workerCanaries,
  type CanaryEntry,
  type CanaryRegistry,
  type PagePatterns
} from "./canaryRegistry";
import { routePatternFor } from "./routePatterns";

const WRAPPERS_BY_SLUG = edgeWrappers as Record<string, string[]>;

/** A source hit with the detail the committed file leaves out. */
export type SourceDetail = ObservedFlow & {
  canary: string;
  /** Column the canary was seeded into */
  seededColumn: string;
  url: string;
  /** Whether `classifyResponse` (the ingest path's parser) returned the value as classified */
  parserClassified: boolean | null;
};

/** A sink hit as the page reported it, resolved to canaries. */
export type SinkDetail = {
  route: string;
  test: string;
  component: string;
  sourceFile: string | null;
  unmaskedBy: string | null;
  blocked: boolean;
  /** "text", "attr:<name>", "value", or "title" */
  where: string;
  selector: string;
  canary: string;
  kind: ObservedKind;
  seededColumn: string;
};

/** What the in-page scanner sends for one match. */
type PageSinkHit = {
  matched: string[];
  where: string;
  selector: string;
  component: string;
  sourceFile: string | null;
  unmaskedBy: string | null;
  blocked: boolean;
};

export type TracePartial = {
  observed: ObservedFlow[];
  sinks: PiiSinks;
  sourceDetails: SourceDetail[];
  sinkDetails: SinkDetail[];
  seeded: { value: string; entry: CanaryEntry }[];
  seenAtSource: string[];
  seenAtSink: string[];
  pages: { route: string; test: string }[];
};

export type TaintTracerOptions = {
  registry?: CanaryRegistry;
  /** Routes (patterns) this tracer ignores, e.g. test harness pages */
  ignoreRoutes?: RegExp;
};

/** Flight properties that hold rendered React content rather than data. */
const RENDERED_PROPS = new Set([
  "children",
  "dangerouslySetInnerHTML",
  "title",
  "alt",
  "aria-label",
  "placeholder",
  "value",
  "defaultValue"
]);

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_DETAILS = 20000;
let tracerCount = 0;

function supabaseOrigin(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Visits every leaf under `value` (strings and numbers), with its JSONPath (array indexes as `[*]`). */
function walkLeaves(value: unknown, path: string, visit: (leaf: string, path: string) => void) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") visit(value, path);
  else if (typeof value === "number" || typeof value === "boolean") visit(String(value), path);
  else if (Array.isArray(value)) for (const v of value) walkLeaves(v, `${path}[*]`, visit);
  else if (typeof value === "object")
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walkLeaves(v, `${path}.${k}`, visit);
}

/**
 * Visits every leaf of PostgREST rows with the `table.column` that holds it, following the
 * `select=` tree through aliases, FK hints, and embeds the same way `selectParser` does.
 */
function walkRows(
  relation: string,
  rows: unknown,
  select: SelectTree | null,
  visit: (leaf: string, key: string) => void
) {
  if (Array.isArray(rows)) {
    for (const r of rows) walkRows(relation, r, select, visit);
    return;
  }
  if (rows === null || typeof rows !== "object") return;
  const byKey = new Map((select?.items ?? []).map((i) => [i.key, i]));
  for (const [key, value] of Object.entries(rows as Record<string, unknown>)) {
    const item = byKey.get(key);
    if (item?.children) {
      const target = resolveEmbed(relation, item);
      if (target) walkRows(target, value, item.children, visit);
      else walkLeaves(value, "", (leaf) => visit(leaf, `?${relation}.${key} (embed)`));
      continue;
    }
    const colKey = `${relation}.${item ? item.name : key}`;
    walkLeaves(value, "", (leaf) => visit(leaf, colKey));
  }
}

/**
 * Visits the leaves of a realtime frame. Rows sit under `data` (broadcasts), or `record` and
 * `old_record` (postgres_changes), in an object that names its `table`.
 */
function walkRealtime(
  value: unknown,
  table: string | null,
  path: string,
  visit: (leaf: string, table: string | null, key: string) => void
) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) walkRealtime(v, table, `${path}[*]`, visit);
    return;
  }
  if (typeof value !== "object") {
    visit(String(value), table, `?${path}`);
    return;
  }
  const obj = value as Record<string, unknown>;
  const here = typeof obj.table === "string" ? obj.table : table;
  for (const [k, v] of Object.entries(obj)) {
    if (
      here &&
      typeof obj.table === "string" &&
      (k === "data" || k === "record" || k === "old_record") &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      for (const [col, cell] of Object.entries(v as Record<string, unknown>)) {
        walkLeaves(cell, "", (leaf) => visit(leaf, here, `${here}.${col}`));
      }
      continue;
    }
    walkRealtime(v, here, `${path}.${k}`, visit);
  }
}

/** The JSON property a string value at `offset` belongs to, read back from the raw payload text. */
function propertyBefore(text: string, offset: number): string | null {
  const before = text.slice(Math.max(0, offset - 400), offset).replace(/\\"/g, '"');
  const m = before.match(/"([A-Za-z_$][\w$]*)"\s*:\s*"(?:[^"\\]|\\.)*$/);
  return m ? m[1] : null;
}

/** Extracts the flight data pushed through `self.__next_f` in an HTML document. */
function flightChunks(html: string): string {
  const out: string[] = [];
  const re = /self\.__next_f\.push\(\[\d+,\s*("(?:[^"\\]|\\.)*")\]\)/g;
  for (const m of html.matchAll(re)) {
    try {
      out.push(JSON.parse(m[1]) as string);
    } catch {
      /* not a string chunk */
    }
  }
  return out.join("");
}

/**
 * In-page DOM scanner, installed with `addInitScript`. Self-contained: Playwright serializes it.
 * It rescans 300 ms after the DOM stops changing (at most 1.5 s apart while it keeps changing) and
 * reports each (match, place) once per document.
 */
function installSinkScanner(args: {
  patternsBinding: string;
  sinksBinding: string;
  scanNow: string;
  tokenSource: string;
}) {
  const w = window as unknown as Record<string, unknown>;
  const flag = `__installed_${args.sinksBinding}`;
  if (w[flag]) return;
  w[flag] = true;
  let tokens = new Set<string>();
  let phrases: string[] = [];
  let version = -1;
  const reported = new Set<string>();
  const tokenRe = new RegExp(args.tokenSource, "gu");
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  const ATTRS = ["title", "alt", "aria-label", "aria-description", "placeholder", "href", "src", "data-tooltip"];
  const matches = (text: string): string[] => {
    const n = norm(text);
    const out: string[] = [];
    for (const m of n.matchAll(tokenRe)) if (tokens.has(m[0])) out.push(m[0]);
    for (const p of phrases) if (n.includes(p)) out.push(p);
    return out;
  };
  const componentOf = (el: Element | null) => {
    const c = el?.closest("[data-sentry-component]");
    return c
      ? {
          name: c.getAttribute("data-sentry-component") ?? "(unannotated)",
          file: c.getAttribute("data-sentry-source-file")
        }
      : { name: "(unannotated)", file: null };
  };
  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let depth = 0; cur && depth < 4 && cur !== document.body; depth++) {
      let part = cur.tagName.toLowerCase();
      const testId = cur.getAttribute("data-testid");
      const label = cur.getAttribute("aria-label");
      if (cur.id) part += `#${cur.id}`;
      else if (testId) part += `[data-testid="${testId}"]`;
      else if (label && label.length < 40) part += `[aria-label]`;
      parts.unshift(part);
      if (cur.id || testId) break;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  const describe = (el: Element, where: string, matched: string[]) => {
    const component = componentOf(el);
    const unmask = el.closest("[data-report-unmask]");
    return {
      matched,
      where,
      selector: selectorOf(el),
      component: component.name,
      sourceFile: component.file,
      unmaskedBy: unmask ? componentOf(unmask).name : null,
      blocked: !!el.closest("[data-report-block]")
    };
  };
  let running = false;
  const scan = async () => {
    if (running) return;
    running = true;
    try {
      const p = (await (w[args.patternsBinding] as (v: number) => Promise<PagePatterns | null>)(version)) ?? null;
      if (p) {
        tokens = new Set(p.tokens);
        phrases = p.phrases;
        version = p.version;
      }
      if (tokens.size === 0 && phrases.length === 0) return;
      const root = document.body ?? document.documentElement;
      if (!root) return;
      const hits: ReturnType<typeof describe>[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        const text = n.nodeValue;
        if (!parent || !text || text.length < 3) continue;
        if (parent.closest("script,style,noscript,template")) continue;
        const m = matches(text);
        if (m.length) hits.push(describe(parent, "text", m));
      }
      for (const el of root.querySelectorAll(
        "[title],[alt],[aria-label],[aria-description],[placeholder],[href],[src],[data-tooltip],input,textarea,select"
      )) {
        for (const attr of ATTRS) {
          const v = el.getAttribute(attr);
          if (!v || v.length < 3) continue;
          const m = matches(v);
          if (m.length) hits.push(describe(el, `attr:${attr}`, m));
        }
        const value = (el as HTMLInputElement).value;
        if (typeof value === "string" && value.length >= 3 && (el as HTMLInputElement).type !== "password") {
          const m = matches(value);
          if (m.length) hits.push(describe(el, "value", m));
        }
      }
      if (document.title) {
        const m = matches(document.title);
        if (m.length)
          hits.push({
            matched: m,
            where: "title",
            selector: "title",
            component: "document.title",
            sourceFile: null,
            unmaskedBy: null,
            blocked: false
          });
      }
      const fresh = hits.filter((h) => {
        const key = `${h.where}|${h.selector}|${h.component}|${h.unmaskedBy}|${h.matched.join(",")}`;
        if (reported.has(key)) return false;
        reported.add(key);
        return true;
      });
      if (fresh.length)
        await (w[args.sinksBinding] as (path: string, hits: unknown[]) => Promise<void>)(location.pathname, fresh);
    } catch (e) {
      // Never break the page under test; the tracer reports this console line.
      // eslint-disable-next-line no-console
      console.warn("[bug-report-trace] DOM scan failed:", String(e));
    } finally {
      running = false;
    }
  };
  w[args.scanNow] = scan;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstPending = 0;
  const schedule = () => {
    const now = Date.now();
    w.__bugReportTraceLastMutation = now;
    if (!timer) firstPending = now;
    if (timer) clearTimeout(timer);
    const wait = now - firstPending > 1500 ? 0 : 300;
    timer = setTimeout(() => {
      timer = null;
      void scan();
    }, wait);
  };
  const start = () => {
    schedule();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS
    });
    document.addEventListener("input", schedule, true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}

/**
 * Collects sources and sinks for canaries in one or more browser contexts. The worker-level
 * instance (`workerTracer`) is attached to every context under `BUG_REPORT_TRACE=1`; a test can
 * make its own instance to inspect one scenario in isolation.
 */
export class TaintTracer {
  readonly id = `${process.pid}_${++tracerCount}`;
  currentTest = "(no test)";
  private readonly registry: CanaryRegistry;
  private readonly matcher: CanaryMatcher;
  private readonly ignoreRoutes: RegExp | null;
  private readonly observed: ObservedFlow[] = [];
  private readonly sinkMap: PiiSinks = {};
  private readonly sourceDetails: SourceDetail[] = [];
  private readonly sinkDetails: SinkDetail[] = [];
  private readonly seenAtSource = new Set<string>();
  private readonly seenAtSink = new Set<string>();
  private readonly pages = new Map<string, { route: string; test: string }>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly supabase = supabaseOrigin();
  private readonly attached = new WeakSet<BrowserContext>();

  constructor(options: TaintTracerOptions = {}) {
    this.registry = options.registry ?? workerCanaries;
    this.matcher = new CanaryMatcher(this.registry);
    this.ignoreRoutes = options.ignoreRoutes ?? null;
  }

  private get bindings() {
    return {
      patternsBinding: `__bugReportTracePatterns_${this.id}`,
      sinksBinding: `__bugReportTraceSinks_${this.id}`,
      scanNow: `__bugReportTraceScanNow_${this.id}`,
      tokenSource: TOKEN_PATTERN_SOURCE
    };
  }

  /** Starts tracing a context: every current and future page in it. */
  async attachContext(context: BrowserContext): Promise<void> {
    if (this.attached.has(context)) return;
    this.attached.add(context);
    const b = this.bindings;
    await context.exposeBinding(b.patternsBinding, (_source, version: number) => {
      const p = this.matcher.forPage();
      return p.version === version ? null : p;
    });
    await context.exposeBinding(b.sinksBinding, (source, pathname: string, hits: PageSinkHit[]) => {
      this.recordSinks(pathname, hits);
    });
    await context.addInitScript(installSinkScanner, b);
    // Context-level, so requests from web and service workers count too.
    context.on("response", (response) => {
      let page: Page | null = null;
      try {
        page = response.frame().page();
      } catch {
        page = context.pages()[0] ?? null;
      }
      this.track(this.onResponse(page, response).catch(() => {}));
    });
    for (const page of context.pages()) this.attachPage(page);
    context.on("page", (page) => this.attachPage(page));
    // Scan once more and drain pending response reads before the context goes away.
    const close = context.close.bind(context);
    context.close = async (...args: Parameters<BrowserContext["close"]>) => {
      await this.scanNow(context);
      await this.flush();
      return close(...args);
    };
  }

  /** Rescans the DOM of every open page in `context` now. */
  async scanNow(context: BrowserContext): Promise<void> {
    const fn = this.bindings.scanNow;
    await Promise.all(
      context.pages().map((p) =>
        p
          .evaluate(async (name) => {
            const scan = (window as unknown as Record<string, () => Promise<void>>)[name];
            if (scan) await scan();
          }, fn)
          .catch(() => {})
      )
    );
  }

  /**
   * Waits until the page's DOM has not changed for `quietMs` (the scanner timestamps every
   * mutation), then rescans. For tours that visit pages without waiting on specific content.
   */
  async settle(page: Page, { quietMs = 1500, timeout = 30_000 } = {}): Promise<void> {
    await page
      .waitForFunction(
        (quiet) => {
          const last = (window as unknown as { __bugReportTraceLastMutation?: number }).__bugReportTraceLastMutation;
          return last !== undefined && Date.now() - last > quiet && document.readyState === "complete";
        },
        quietMs,
        { timeout, polling: 250 }
      )
      .catch(() => {});
    await this.scanNow(page.context());
  }

  /** Waits for every response and frame still being read. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>) {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private route(url: string): string {
    try {
      return routePatternFor(new URL(url).pathname);
    } catch {
      return "(unknown)";
    }
  }

  private attachPage(page: Page) {
    page.on("console", (msg) => {
      if (msg.text().startsWith("[bug-report-trace]")) process.stderr.write(`${msg.text()} (${page.url()})\n`);
    });
    page.on("websocket", (ws) => this.onWebSocket(page, ws));
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const route = this.route(frame.url());
      if (this.ignored(route)) return;
      this.pages.set(`${route}\u0000${this.currentTest}`, { route, test: this.currentTest });
    });
  }

  private ignored(route: string) {
    return this.ignoreRoutes !== null && this.ignoreRoutes.test(route);
  }

  private addFlow(detail: Omit<SourceDetail, "test" | "firstSeenIn">, pageUrl: string) {
    const route = this.route(pageUrl);
    if (this.ignored(route)) return;
    const flow: SourceDetail = { ...detail, firstSeenIn: route, test: this.currentTest };
    this.observed.push({ source: flow.source, key: flow.key, kind: flow.kind, firstSeenIn: route, test: flow.test });
    this.seenAtSource.add(flow.canary);
    if (this.sourceDetails.length < MAX_DETAILS) this.sourceDetails.push(flow);
  }

  private async onResponse(page: Page | null, response: Response) {
    if (this.registry.size === 0) return;
    const request = response.request();
    const type = request.resourceType();
    if (!["document", "fetch", "xhr", "eventsource", "other"].includes(type)) return;
    const status = response.status();
    if (status < 200 || status >= 300 || status === 204) return;
    const url = new URL(response.url());
    if (url.pathname.startsWith("/_next/static") || url.pathname.startsWith("/_next/image")) return;
    const fromSupabase = this.supabase !== null && url.origin === this.supabase;
    const pageUrl = type === "document" || !page ? response.url() : page.url();
    let body: Buffer;
    try {
      body = await response.body();
    } catch {
      return;
    }
    if (body.length > MAX_BODY_BYTES) return;
    const text = body.toString("utf8");
    const hits = this.matcher.find(text);
    if (hits.length === 0) return;
    const subset = new CanaryMatcher(new Map(hits.map((h) => [h.canary, h.entry])));
    const method = request.method();

    if (fromSupabase) {
      if (url.pathname.startsWith("/auth/v1/")) {
        // The auth session (ingest point 5) is tainted wholesale, not through privacy.ts.
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }
      const select = url.searchParams.get("select");
      const tree = select ? parseSelect(select) : null;
      const parsed = classifyResponse(response.url(), method, json);
      const classifiedValues = new Set(parsed.values.map((v) => normalizeForMatch(v.value)));
      const emit = (source: string, leaf: string, key: string) => {
        for (const hit of subset.find(leaf)) {
          this.addFlow(
            {
              source,
              key,
              kind: hit.entry.kind,
              canary: hit.canary,
              seededColumn: hit.entry.column,
              url: `${url.origin}${url.pathname}`,
              parserClassified: classifiedValues.has(normalizeForMatch(leaf))
            },
            pageUrl
          );
        }
      };
      let m: RegExpMatchArray | null;
      if ((m = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)\/?$/))) {
        const fn = decodeURIComponent(m[1]);
        const c = RPCS[fn];
        if (c !== undefined && isTableRef(c))
          walkRows(c.$table, json, tree, (leaf, key) => emit(`rpc:${fn}`, leaf, key));
        else walkLeaves(json, "$", (leaf, path) => emit(`rpc:${fn}`, leaf, path));
      } else if ((m = url.pathname.match(/\/rest\/v1\/([^/]+)\/?$/))) {
        const relation = decodeURIComponent(m[1]);
        walkRows(relation, json, tree, (leaf, key) => emit(`rest:${relation}`, leaf, key));
      } else if ((m = url.pathname.match(/\/functions\/v1\/([^/]+)/))) {
        const slug = decodeURIComponent(m[1]);
        const wrappers = WRAPPERS_BY_SLUG[slug];
        const source = wrappers?.length === 1 ? `edge:${wrappers[0]}` : `edge:${slug}`;
        walkLeaves(json, "$", (leaf, path) => emit(source, leaf, path));
      } else {
        walkLeaves(json, "$", (leaf, path) => emit(`supabase:${url.pathname}`, leaf, path));
      }
      return;
    }

    // Same-origin: RSC payloads (client navigation), the initial HTML's flight chunks, and /api routes.
    const isRsc = request.headers()["rsc"] === "1" || url.searchParams.has("_rsc");
    const contentType = response.headers()["content-type"] ?? "";
    if (isRsc || contentType.includes("text/x-component")) {
      this.emitFlight(text, subset, `rsc:${this.route(response.url())}`, response.url(), pageUrl);
    } else if (type === "document" || contentType.includes("text/html")) {
      this.emitFlight(flightChunks(text), subset, `rsc:${this.route(response.url())}`, response.url(), pageUrl);
    } else if (url.pathname.startsWith("/api/")) {
      const source = `api:${routePatternFor(url.pathname)}`;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      walkLeaves(json, "$", (leaf, path) => {
        for (const hit of subset.find(leaf)) {
          this.addFlow(
            {
              source,
              key: path,
              kind: hit.entry.kind,
              canary: hit.canary,
              seededColumn: hit.entry.column,
              url: `${url.origin}${url.pathname}`,
              parserClassified: null
            },
            pageUrl
          );
        }
      });
    }
  }

  /**
   * Flight data is not JSON as a whole, so each hit is located in the text and attributed to the
   * JSON property it sits in. When that property has the seeded column's name, the flow is keyed
   * by the seeded column; otherwise by `?<property>`, which the check reports as unclassified.
   */
  private emitFlight(text: string, subset: CanaryMatcher, source: string, url: string, pageUrl: string) {
    if (!text) return;
    const lower = text.toLowerCase();
    const byNeedle = new Map<string, ReturnType<CanaryMatcher["find"]>>();
    for (const hit of subset.find(text)) byNeedle.set(hit.matched, [...(byNeedle.get(hit.matched) ?? []), hit]);
    const emitted = new Set<string>();
    for (const [needle, candidates] of byNeedle) {
      for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
        const prop = propertyBefore(text, at);
        // One anchor can stand for several seeded values (a name, its sortable and short forms);
        // prefer the one whose column the property is named after.
        const named = candidates.find((c) => prop !== null && c.entry.column.split(".").pop() === prop);
        const hit = named ?? candidates[0];
        const key = named
          ? named.entry.column
          : prop === null || RENDERED_PROPS.has(prop)
            ? `?rendered:${prop ?? "markup"}`
            : `?${prop}`;
        const id = `${key}\u0000${hit.canary}`;
        if (emitted.has(id)) continue;
        emitted.add(id);
        this.addFlow(
          {
            source,
            key,
            kind: hit.entry.kind,
            canary: hit.canary,
            seededColumn: hit.entry.column,
            url: url.split("?")[0],
            parserClassified: null
          },
          pageUrl
        );
      }
    }
  }

  private onWebSocket(page: Page, ws: WebSocket) {
    ws.on("framereceived", ({ payload }) => {
      if (this.registry.size === 0) return;
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      const hits = this.matcher.find(text);
      if (hits.length === 0) return;
      const subset = new CanaryMatcher(new Map(hits.map((h) => [h.canary, h.entry])));
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      const pageUrl = page.url();
      walkRealtime(json, null, "$", (leaf, table, key) => {
        for (const hit of subset.find(leaf)) {
          this.addFlow(
            {
              source: `realtime:${table ?? "(unknown)"}`,
              key,
              kind: hit.entry.kind,
              canary: hit.canary,
              seededColumn: hit.entry.column,
              url: ws.url().split("?")[0],
              parserClassified: null
            },
            pageUrl
          );
        }
      });
    });
  }

  private recordSinks(pathname: string, hits: PageSinkHit[]) {
    const route = routePatternFor(pathname);
    if (this.ignored(route)) return;
    this.pages.set(`${route}\u0000${this.currentTest}`, { route, test: this.currentTest });
    for (const hit of hits) {
      const canaries = new Set<string>();
      for (const matched of hit.matched) for (const found of this.matcher.find(matched)) canaries.add(found.canary);
      for (const canary of canaries) {
        const entry = this.registry.get(canary);
        if (!entry) continue;
        this.seenAtSink.add(canary);
        const component = sinkComponentKey(hit.component, hit.unmaskedBy);
        const kinds = ((this.sinkMap[route] ??= {})[component] ??= []);
        if (!kinds.includes(entry.kind)) kinds.push(entry.kind);
        if (this.sinkDetails.length < MAX_DETAILS) {
          this.sinkDetails.push({
            route,
            test: this.currentTest,
            component: hit.component,
            sourceFile: hit.sourceFile,
            unmaskedBy: hit.unmaskedBy,
            blocked: hit.blocked,
            where: hit.where,
            selector: hit.selector,
            canary,
            kind: entry.kind,
            seededColumn: entry.column
          });
        }
      }
    }
  }

  /** Observed flows so far, one per (source, key, kind). */
  observedFlows(): ObservedFlow[] {
    return normalizeObserved(this.observed);
  }

  /** Observed flows so far, including the canary and URL of each hit. */
  observedDetails(): readonly SourceDetail[] {
    return this.sourceDetails;
  }

  sinks(): PiiSinks {
    return normalizeSinks(this.sinkMap);
  }

  sinkHits(): readonly SinkDetail[] {
    return this.sinkDetails;
  }

  /** Sinks seen during one test, from the recorded hits. */
  sinksFor(test: string): PiiSinks {
    const out: PiiSinks = {};
    for (const d of this.sinkDetails) {
      if (d.test !== test) continue;
      const kinds = ((out[d.route] ??= {})[sinkComponentKey(d.component, d.unmaskedBy)] ??= []);
      if (!kinds.includes(d.kind)) kinds.push(d.kind);
    }
    return normalizeSinks(out);
  }

  /** Everything this tracer collected, for the worker's partial file. */
  partial(): TracePartial {
    return {
      observed: this.observedFlows(),
      sinks: this.sinks(),
      sourceDetails: this.sourceDetails,
      sinkDetails: this.sinkDetails,
      seeded: [...this.registry].map(([value, entry]) => ({ value, entry })),
      seenAtSource: [...this.seenAtSource],
      seenAtSink: [...this.seenAtSink],
      pages: [...this.pages.values()]
    };
  }
}
