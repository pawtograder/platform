/**
 * The bug-report recorder: rrweb on the main thread into an on-device ring buffer.
 *
 * Nothing here uploads anything. The buffer leaves this module only through `freeze()`, which
 * the review dialog calls when the user opens "Report a bug"; the envelope builder uploads
 * only after the user submits. Error events sent while recording carry `replay_id` in their
 * dynamic sampling context (the envelope's `trace` header) so Sentry can link them to a
 * replay that may or may not be submitted later.
 *
 * This module is loaded only through the dynamic import in
 * `components/bugReport/BugReportRecorder.tsx`, when the course flag is on and the route is
 * listed in the route policy. It is the only place that imports rrweb's recorder.
 */
import { addCustomEvent, record, takeFullSnapshot } from "@sentry-internal/rrweb";
import * as Sentry from "@sentry/nextjs";
import { setActiveRecorder } from "./activeRecorder";
import { linkedErrorsSince, noteLinkedError } from "./errorLinks";
import { onFetch, type FetchObservation } from "./fetchHook";
import { startIngest, type IngestHandle, type IngestStats } from "./ingest";
import { RingBuffer } from "./ringBuffer";
import { courseIdFromPathname, recordingLevelFor, type RecordingLevel } from "./routePolicy";
import { getTaintSet, readTaintBlocks, TAINT_BLOCK_ID, type TaintKind, type TaintStats } from "./taint";
import {
  BREADCRUMB_TAG,
  type BreadcrumbPayload,
  type BugReportRecorder,
  type ConsoleBreadcrumb,
  type FrozenBuffer,
  type LinkedError,
  type RecordedEvent,
  type RecorderStartOptions,
  type RecorderState
} from "./types";

/**
 * Recorded as sized placeholders (rrweb keeps only the class and the box size): media, code
 * and markdown editors, avatars, anything a component marks with `data-report-block`, and
 * inputs whose values must never be recorded even masked (password, token, hidden, file).
 */
export const BLOCK_SELECTOR = [
  "img",
  "picture",
  "video",
  "audio",
  "canvas",
  "iframe",
  "object",
  "embed",
  "svg image",
  // Monaco, the uiw markdown editor, CodeMirror.
  ".monaco-editor",
  ".w-md-editor",
  ".cm-editor",
  // Chakra v3 Avatar root (image or initials).
  '[data-scope="avatar"][data-part="root"]',
  "[data-report-block]",
  'input[type="password"]',
  'input[type="hidden"]',
  'input[type="file"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="token" i]',
  'input[id*="token" i]',
  'input[name*="secret" i]',
  'input[id*="secret" i]',
  'input[name*="api_key" i]',
  'input[name*="apikey" i]',
  "[data-report-secret]"
].join(", ");

/** The only way to unmask text, and only at level `full`. */
export const UNMASK_SELECTOR = "[data-report-unmask]";

/** Attributes that carry human-readable text; masked like text nodes. */
const TEXT_ATTRIBUTES = new Set([
  "title",
  "alt",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "aria-placeholder",
  "aria-roledescription",
  "placeholder",
  "label",
  "summary",
  "value",
  "download"
]);

const MAX_CONSOLE_MESSAGE = 2000;
const MAX_CLICK_DESCRIPTION = 300;
/** Query parameters dropped from fetch breadcrumb URLs. */
const SECRET_QUERY_PARAMS = /^(apikey|api_key|access_token|refresh_token|token|code|secret|password)$/i;

function maskText(text: string): string {
  return text.replace(/\S/g, "*");
}

function newReplayId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Ends a console message that was cut short. */
const TRUNCATED_MARKER = "[truncated]";
/** How deep `consoleLeaves` walks into objects and arrays, and how many leaves it takes. */
const MAX_CONSOLE_DEPTH = 4;
const MAX_CONSOLE_LEAVES = 200;

/**
 * The strings in a console argument, one per line. Strings are kept exactly as logged: a JSON
 * rendering would escape quotes, tabs, and backslashes, and the taint patterns (made from the raw
 * values) would no longer match them. Object leaves carry their key (`key: value`), so a free-text
 * line is still a substring of its own line.
 */
function consoleLeaves(arg: unknown, out: string[], depth: number, seen: Set<object>, key?: string): void {
  if (out.length >= MAX_CONSOLE_LEAVES) return;
  const push = (text: string) => out.push(key === undefined ? text : `${key}: ${text}`);
  if (typeof arg === "string") return void push(arg);
  if (arg === null || typeof arg !== "object") {
    if (typeof arg === "function") return void push(`[function ${arg.name || "anonymous"}]`);
    return void push(String(arg));
  }
  if (arg instanceof Error) return void push(`${arg.name}: ${arg.message}`);
  if (typeof Node !== "undefined" && arg instanceof Node) return void push(`[${arg.nodeName.toLowerCase()}]`);
  if (depth >= MAX_CONSOLE_DEPTH || seen.has(arg)) return void push(Array.isArray(arg) ? "[Array]" : "[Object]");
  seen.add(arg);
  let entries: [string | undefined, unknown][];
  try {
    if (Array.isArray(arg)) entries = arg.map((v) => [undefined, v]);
    else if (arg instanceof Map) entries = Array.from(arg, ([k, v]) => [String(k), v]);
    else if (arg instanceof Set) entries = Array.from(arg, (v) => [undefined, v]);
    else entries = Object.entries(arg);
  } catch {
    return void push("[Object]");
  }
  for (const [k, v] of entries) {
    consoleLeaves(v, out, depth + 1, seen, k);
    if (out.length >= MAX_CONSOLE_LEAVES) return;
  }
}

/**
 * A console call's message: string arguments as they are, joined by spaces, and the string leaves
 * of object arguments on their own lines. Past `MAX_CONSOLE_MESSAGE` it is cut at a line boundary.
 * A line that doesn't fit is dropped whole, never cut: a cut line would no longer match its taint
 * pattern, and its readable start would be uploaded.
 */
export function consoleMessage(args: readonly unknown[]): string {
  const parts: string[] = [];
  for (const arg of args) {
    const leaves: string[] = [];
    consoleLeaves(arg, leaves, 0, new Set());
    parts.push(leaves.join("\n"));
  }
  const message = parts.join(" ");
  if (message.length <= MAX_CONSOLE_MESSAGE) return message;
  const lines = message.split("\n");
  let kept = "";
  for (const line of lines) {
    const next = kept.length === 0 ? line : `${kept}\n${line}`;
    if (next.length > MAX_CONSOLE_MESSAGE - TRUNCATED_MARKER.length - 1) break;
    kept = next;
  }
  return kept.length === 0 ? TRUNCATED_MARKER : `${kept}\n${TRUNCATED_MARKER}`;
}

function describeElement(el: Element): string {
  let out = el.tagName.toLowerCase();
  if (el.id) out += `#${el.id}`;
  for (const cls of Array.from(el.classList).slice(0, 5)) out += `.${cls}`;
  const testId = el.getAttribute("data-testid");
  if (testId) out += `[data-testid="${testId}"]`;
  const role = el.getAttribute("role");
  if (role) out += `[role="${role}"]`;
  return out.slice(0, MAX_CLICK_DESCRIPTION);
}

function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of Array.from(u.searchParams.keys())) {
      if (SECRET_QUERY_PARAMS.test(key)) u.searchParams.set(key, "[Filtered]");
    }
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return url;
  }
}

type UrlVisit = { url: string; at: number };

/** Hooks on the Sentry client are installed once per page load and read the active recorder. */
let sentryHooksInstalled = false;
let current: Recorder | null = null;

function installSentryHooks(): void {
  if (sentryHooksInstalled) return;
  const client = Sentry.getClient();
  if (!client) return;
  sentryHooksInstalled = true;
  client.on("createDsc", (dsc) => {
    const r = current;
    if (r && r.getState() === "recording") dsc.replay_id = r.getReplayId();
  });
  Sentry.getGlobalScope().addEventProcessor((event) => {
    const r = current;
    // Error events only: transactions, feedback, and replay events have a `type`.
    if (r && r.getState() === "recording" && !event.type) {
      r.noteError(event.event_id, event.contexts?.trace?.trace_id);
    }
    return event;
  });
}

class Recorder implements BugReportRecorder {
  private state: RecorderState = "recording";
  private level: RecordingLevel;
  private readonly courseId: number;
  private readonly replayId = newReplayId();
  private readonly buffer: RingBuffer;
  private stopRrweb: (() => void) | undefined;
  private readonly visits: UrlVisit[] = [];
  private readonly errors: LinkedError[] = [];
  private readonly cleanups: (() => void)[] = [];
  /** Pathname whose level was last checked in `onEvent`, so the check runs once per route. */
  private checkedPath: string | null = null;
  private checkoutScheduled = false;
  private inBreadcrumb = false;
  private ingest: IngestHandle | undefined;

  constructor(options: RecorderStartOptions) {
    this.courseId = options.courseId;
    this.level = options.level;
    this.buffer = new RingBuffer(options.limits);
  }

  start(): void {
    // The ingest starts before rrweb takes its first FullSnapshot, so rows already on screen
    // (TableController contents, the pre-start fetch buffer, the session) are tainted too.
    this.ingest = startIngest({ courseId: this.courseId });
    readTaintBlocks(document, getTaintSet());
    this.watchTaintBlocks();
    installSentryHooks();
    this.installBreadcrumbs();
    this.startRrweb();
  }

  /**
   * A taint block can mount after the recorder starts: the course layout renders the page
   * client-side once its data has loaded, and a client navigation renders the new page before
   * or after `onNavigate` runs. Read every block that appears.
   */
  private watchTaintBlocks(): void {
    const selector = `script#${TAINT_BLOCK_ID}`;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        // A block whose text React replaced in place: a text node's data changed, or its
        // children were swapped.
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest(selector)) {
          readTaintBlocks(document, getTaintSet());
          return;
        }
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) {
            readTaintBlocks(document, getTaintSet());
            return;
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    this.cleanups.push(() => observer.disconnect());
  }

  private startRrweb(): void {
    const level = this.level;
    this.checkedPath = window.location.pathname;
    this.noteUrl();
    this.stopRrweb = record<RecordedEvent>({
      emit: (event) => this.onEvent(event),
      checkoutEveryNms: this.buffer.limits.checkoutEveryMs,
      maskAllText: true,
      maskAllInputs: true,
      unmaskTextSelector: level === "full" ? UNMASK_SELECTOR : undefined,
      maskTextFn: maskText,
      maskAttributeFn: (name, value, element) => {
        if (!TEXT_ATTRIBUTES.has(name)) return value;
        if (level === "full" && element.closest(UNMASK_SELECTOR)) return value;
        return maskText(value);
      },
      blockSelector: BLOCK_SELECTOR,
      slimDOMOptions: "all",
      inlineImages: false,
      recordCanvas: false,
      collectFonts: false,
      recordCrossOriginIframes: false,
      // rrweb calls this for errors inside its own observers; report nothing, record on.
      errorHandler: () => true
    });
  }

  private stopRecording(): void {
    this.stopRrweb?.();
    this.stopRrweb = undefined;
  }

  private onEvent(event: RecordedEvent): void {
    if (this.state !== "recording") return;
    // A client navigation changes the URL before the new route's DOM mutations are observed,
    // and before the mount's effect calls onNavigate. Drop anything recorded under a route
    // whose level differs from the running one, and switch over right away.
    const path = window.location.pathname;
    if (path !== this.checkedPath) {
      const level = courseIdFromPathname(path) === this.courseId ? recordingLevelFor(path) : null;
      if (level !== this.level) {
        queueMicrotask(() => this.onNavigate(window.location.pathname));
        return;
      }
      this.checkedPath = path;
    }
    if (this.visits[this.visits.length - 1]?.url !== window.location.href) this.noteUrl();
    const { requestCheckout } = this.buffer.push(event, this.level);
    if (requestCheckout) this.scheduleCheckout();
  }

  private scheduleCheckout(): void {
    if (this.checkoutScheduled) return;
    this.checkoutScheduled = true;
    setTimeout(() => {
      this.checkoutScheduled = false;
      if (this.state === "recording" && this.stopRrweb) takeFullSnapshot(true);
    }, 0);
  }

  private noteUrl(): void {
    this.visits.push({ url: window.location.href, at: Date.now() });
  }

  /** Whether a breadcrumb would be recorded now. Callers check it before building one. */
  private takingBreadcrumbs(): boolean {
    // The guard stops a console call made while adding a breadcrumb from adding another.
    return this.state === "recording" && this.stopRrweb !== undefined && !this.inBreadcrumb;
  }

  private addBreadcrumb(payload: BreadcrumbPayload): void {
    if (!this.takingBreadcrumbs()) return;
    this.inBreadcrumb = true;
    try {
      addCustomEvent(BREADCRUMB_TAG, payload);
    } catch {
      // rrweb throws when not recording; nothing to add then.
    } finally {
      this.inBreadcrumb = false;
    }
  }

  private installBreadcrumbs(): void {
    // Console: wraps the methods, never logs itself.
    /* eslint-disable no-console */
    const levels: ConsoleBreadcrumb["level"][] = ["log", "info", "warn", "error", "debug"];
    for (const level of levels) {
      const original = console[level];
      const patched = (...args: unknown[]) => {
        // Paused on an unlisted route nothing is recorded, so the arguments aren't walked either.
        if (this.takingBreadcrumbs()) {
          this.addBreadcrumb({
            category: "console",
            timestamp: Date.now() / 1000,
            level,
            message: consoleMessage(args)
          });
        }
        original.apply(console, args);
      };
      console[level] = patched;
      this.cleanups.push(() => {
        if (console[level] === patched) console[level] = original;
      });
    }
    /* eslint-enable no-console */

    // Clicks
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || !this.takingBreadcrumbs()) return;
      const id = record.mirror.getId(target);
      this.addBreadcrumb({
        category: "ui.click",
        timestamp: Date.now() / 1000,
        message: describeElement(target),
        data: id > 0 ? { nodeId: id } : {}
      });
    };
    document.addEventListener("click", onClick, { capture: true, passive: true });
    this.cleanups.push(() => document.removeEventListener("click", onClick, { capture: true }));

    // Fetch: URL, method, status, duration. Never bodies or headers.
    this.cleanups.push(
      onFetch((o: FetchObservation) => {
        if (o.url.includes("/api/tunnel") || !this.takingBreadcrumbs()) return;
        this.addBreadcrumb({
          category: "fetch",
          timestamp: Date.now() / 1000,
          data: {
            method: o.method,
            url: sanitizeUrl(o.url),
            status_code: o.status,
            duration: Math.round(o.duration)
          }
        });
      })
    );
  }

  /** Called from the Sentry event processor. */
  noteError(eventId: string | undefined, traceId: string | undefined): void {
    noteLinkedError(this.errors, { eventId, traceId, at: Date.now() });
  }

  // Public API

  freeze(): FrozenBuffer {
    // Free text queued in the taint set is expanded before anything reads the buffer.
    getTaintSet().flush();
    const segments = this.buffer.freeze();
    const startTimestamp = segments[0]?.startTimestamp ?? 0;
    const endTimestamp = segments[segments.length - 1]?.endTimestamp ?? 0;
    // URLs in the kept window: the one current when it starts, and every one after.
    let firstKept = this.visits.findIndex((v) => v.at > startTimestamp);
    if (firstKept === -1) firstKept = this.visits.length;
    const kept = segments.length ? this.visits.slice(Math.max(0, firstKept - 1)) : [];
    // Errors in the kept window only; an empty buffer links none.
    const linked = linkedErrorsSince(this.errors, segments.length ? startTimestamp : Infinity);
    return {
      replayId: this.replayId,
      level: this.level,
      segments,
      startTimestamp,
      endTimestamp,
      urls: Array.from(new Set(kept.map((v) => v.url))),
      errorIds: linked.errorIds,
      traceIds: linked.traceIds,
      errors: linked.errors,
      size: segments.reduce((n, s) => n + s.size, 0)
    };
  }

  getReplayId(): string {
    return this.replayId;
  }

  getErrorIds(): string[] {
    return linkedErrorsSince(this.errors, 0).errorIds;
  }

  getTraceIds(): string[] {
    return linkedErrorsSince(this.errors, 0).traceIds;
  }

  getUrls(): string[] {
    return Array.from(new Set(this.visits.map((v) => v.url)));
  }

  getLevel(): RecordingLevel {
    return this.level;
  }

  getState(): RecorderState {
    return this.state;
  }

  getCourseId(): number {
    return this.courseId;
  }

  addTaint(kind: TaintKind, values: Iterable<string>): void {
    if (this.state === "stopped") return;
    const set = getTaintSet();
    for (const v of values) set.add(kind, v);
  }

  isTaintSaturated(): boolean {
    return getTaintSet().isSaturated();
  }

  onNavigate(pathname: string): void {
    if (this.state === "stopped") return;
    const level = courseIdFromPathname(pathname) === this.courseId ? recordingLevelFor(pathname) : null;
    if (level === null) {
      if (this.state === "recording") {
        // rrweb and the breadcrumbs stop; the taint ingest keeps running. Data fetched here can
        // be rendered on a listed route later without being fetched again (a component's state,
        // a client cache, the router's), and only a TableController's rows would be found again
        // on resume. Missing the rest would leave it readable in the recording.
        this.stopRecording();
        this.state = "paused";
      }
      return;
    }
    readTaintBlocks(document, getTaintSet());
    if (this.state === "paused" || level !== this.level || !this.stopRrweb) {
      // Masking options are fixed at record() time, so a level change restarts rrweb. The
      // restart emits Meta + FullSnapshot, which opens a new segment of the same recording.
      this.stopRecording();
      this.level = level;
      this.state = "recording";
      this.startRrweb();
    }
  }

  stop(): void {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.stopRecording();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.ingest?.stop();
    this.ingest = undefined;
    this.buffer.clear();
    this.visits.length = 0;
    this.errors.length = 0;
    getTaintSet().clear();
    if (current === this) current = null;
    setActiveRecorder(undefined);
  }

  /** Measurement hook: time spent classifying, and the taint set's size. */
  ingestStats(): { ingest: IngestStats | null; taint: TaintStats } {
    return { ingest: this.ingest?.stats() ?? null, taint: getTaintSet().stats() };
  }

  /** Test and measurement hook: buffer statistics without a deep copy. */
  stats(): { size: number; segments: number; events: number; totalPushed: number } {
    return {
      size: this.buffer.size,
      segments: this.buffer.segmentCount,
      events: this.buffer.eventCount,
      totalPushed: this.buffer.totalPushed
    };
  }
}

/**
 * Start recording for this page load. Stops any recorder already running first. The caller
 * (the mount) has checked the course flag and the route policy.
 */
export function startRecorder(options: RecorderStartOptions): BugReportRecorder {
  current?.stop();
  const recorder = new Recorder(options);
  current = recorder;
  recorder.start();
  setActiveRecorder(recorder);
  // E2E builds only (a build-time constant): the leak tests' redaction hook.
  if (process.env.BUG_REPORT_E2E === "true") {
    void import("./redaction/testHook").then((m) => m.installRedactionTestHook());
  }
  return recorder;
}
