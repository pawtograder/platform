/**
 * The cheap half of the taint ingest, loaded with the main bundle (bug reporter spec, package 2).
 *
 * Hot paths (TableController row writes, realtime message routing) call into the ingest only
 * through `bugReportIngest.sink`, which is null unless a recorder is running. The check is one
 * property read, so with the course flag off or on unlisted routes they pay nothing else. The
 * classification itself (`privacy.ts`, the select parser) lives in `ingest.ts`, which only the
 * recorder chunk imports.
 *
 * Two things here run before the recorder chunk has loaded, because the page's first data
 * arrives before it does:
 *
 * - A registry of live TableControllers (a WeakRef each), so the ingest can classify the rows
 *   they already hold, `initialData` included, when it starts.
 * - A pre-start fetch buffer. `<BugReportIngestArm>` in the course layout arms it only when the
 *   server rendered the course flag as on and the route is listed. It keeps a clone of each
 *   Supabase or `/api/` response (unread) until the recorder starts, which classifies them, or
 *   the mount's own flag check finds the flag off, which drops them unread. Without it, rows
 *   fetched outside a TableController in the first second of a page load would be on screen, in
 *   the first FullSnapshot, and never tainted. With the flag off it is never armed.
 *
 * No rrweb, Sentry, or classification import.
 */
import { installFetchHook, onFetch, type FetchObservation } from "./fetchHook";

/** What the running ingest exposes to the hot paths. */
export interface IngestSink {
  /** Rows of `relation` (one row or an array). `select` is the PostgREST select they were read with. */
  rows(relation: string, rows: unknown, select?: string | null): void;
  /** A realtime broadcast payload (`{ table, data, ... }`). */
  broadcast(message: unknown): void;
  /** The course whose recorder runs this ingest. */
  readonly courseId: number | null;
}

/** `sink` is non-null only while the ingest runs. Hot paths check it and nothing else. */
export const bugReportIngest: { sink: IngestSink | null } = { sink: null };

// --- TableController registry -------------------------------------------------------------------

/** The part of a TableController the ingest reads when it starts. */
export interface IngestRowSource {
  /** The relation, its rows, and the select they were read with; null once closed. */
  bugReportRows(): { relation: string; rows: readonly unknown[]; select: string | null } | null;
}

const controllers = new Set<WeakRef<IngestRowSource>>();
let pruneAt = 256;

/** Called from the TableController constructor. Returns the handle to pass to `unregister`. */
export function registerRowSource(source: IngestRowSource): WeakRef<IngestRowSource> | undefined {
  if (typeof WeakRef === "undefined") return undefined;
  const ref = new WeakRef(source);
  controllers.add(ref);
  if (controllers.size >= pruneAt) {
    for (const r of controllers) if (r.deref() === undefined) controllers.delete(r);
    pruneAt = Math.max(256, controllers.size * 2);
  }
  return ref;
}

export function unregisterRowSource(ref: WeakRef<IngestRowSource> | undefined): void {
  if (ref) controllers.delete(ref);
}

/** Every live row source, for the ingest's start-up pass. */
export function liveRowSources(): IngestRowSource[] {
  const out: IngestRowSource[] = [];
  for (const r of controllers) {
    const source = r.deref();
    if (source) out.push(source);
    else controllers.delete(r);
  }
  return out;
}

// --- The server's flag value ------------------------------------------------------------------

/**
 * The `bug-report-recording` flag as the course layout read it on the server, by course. The
 * recorder mount reads it to skip its own flag query while no recorder runs: with the flag off,
 * a navigation between listed routes then costs no request at all. The value is as of the last
 * layout render, so turning the flag on takes effect on the next page load; turning it off is
 * caught by the mount's own query, which it still runs while a recorder exists (test A6).
 */
const serverFlags = new Map<number, boolean>();
const serverFlagWaiters = new Set<(courseId: number) => void>();

/** Called by `<BugReportIngestArm>` on every render. */
export function noteServerRecordingFlag(courseId: number, enabled: boolean): void {
  serverFlags.set(courseId, enabled);
  for (const waiter of Array.from(serverFlagWaiters)) waiter(courseId);
}

/**
 * The server's value for `courseId` once the course layout has rendered it. On a full load the
 * root layout's effects can run before the course layout has streamed in, so the mount waits for
 * it, up to `timeoutMs`, and resolves undefined if it never comes.
 */
export function waitForServerRecordingFlag(courseId: number, timeoutMs: number): Promise<boolean | undefined> {
  const known = serverFlags.get(courseId);
  if (known !== undefined) return Promise.resolve(known);
  return new Promise((resolve) => {
    const done = () => {
      serverFlagWaiters.delete(waiter);
      clearTimeout(timer);
      resolve(serverFlags.get(courseId));
    };
    const waiter = (id: number) => {
      if (id === courseId) done();
    };
    const timer = setTimeout(done, timeoutMs);
    serverFlagWaiters.add(waiter);
  });
}

/** The server's value for `courseId`, or undefined when no course layout has rendered it. */
export function serverRecordingFlag(courseId: number): boolean | undefined {
  return serverFlags.get(courseId);
}

// --- Pre-start fetch buffer ---------------------------------------------------------------------

export type BufferedResponse = { method: string; url: string; response: Response };

/** Enough for a page load's first burst; past it the oldest are dropped (and counted). */
const MAX_BUFFERED = 300;

let armed: { unsubscribe: () => void; queue: BufferedResponse[]; dropped: number } | null = null;

/**
 * Whether a response may carry classified data: Supabase REST, RPC, edge functions, and auth,
 * and this app's `/api/` routes. Everything else (static assets, the Sentry tunnel, third parties)
 * is skipped before its body is touched.
 */
export function isIngestUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.href);
  } catch {
    return false;
  }
  if (/\/(rest|functions|auth)\/v1\//.test(u.pathname))
    return supabaseOrigin() === null || u.origin === supabaseOrigin();
  if (typeof window !== "undefined" && u.origin === window.location.origin) {
    return u.pathname.startsWith("/api/") && !u.pathname.startsWith("/api/tunnel");
  }
  return false;
}

let cachedSupabaseOrigin: string | null | undefined;
function supabaseOrigin(): string | null {
  if (cachedSupabaseOrigin !== undefined) return cachedSupabaseOrigin;
  try {
    cachedSupabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
      : null;
  } catch {
    cachedSupabaseOrigin = null;
  }
  return cachedSupabaseOrigin;
}

/**
 * Bodies over this many bytes are not parsed; the ingest counts them in its stats. Far above any
 * PostgREST page (1,000 rows), so in practice only bulk exports reach it.
 */
export const MAX_INGEST_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Whether a response is worth cloning: a JSON body (error statuses included, since edge-function
 * errors quote usernames) that isn't a stream and doesn't announce itself as huge.
 */
export function isJsonResponse(response: Response): boolean {
  if (response.bodyUsed || response.body === null) return false;
  const type = response.headers.get("content-type") ?? "";
  if (!/json/i.test(type) || /ndjson|event-stream|stream\+json/i.test(type)) return false;
  const length = Number(response.headers.get("content-length"));
  return !(length > MAX_INGEST_BODY_BYTES);
}

function onPreStartFetch(o: FetchObservation): void {
  if (!armed || !o.response || !isIngestUrl(o.url) || !isJsonResponse(o.response)) return;
  let clone: Response;
  try {
    clone = o.response.clone();
  } catch {
    return;
  }
  armed.queue.push({ method: o.method, url: o.url, response: clone });
  if (armed.queue.length > MAX_BUFFERED) {
    armed.queue.shift();
    armed.dropped++;
  }
}

/**
 * Start buffering responses for the recorder that may start on this page. Idempotent. The mount
 * calls it when the route is listed; `disarmIngest` or `takeBufferedResponses` ends it.
 *
 * A running ingest for the same course makes the buffer unnecessary. One for another course
 * doesn't: on a client navigation from course A to course B, B's layout renders (and its first
 * fetches start) while A's recorder still runs. The mount then stops A, which clears the taint set,
 * and starts B's recorder. The buffer is what carries B's first responses across that switch.
 */
export function armIngest(courseId?: number): void {
  if (armed || typeof window === "undefined") return;
  const sink = bugReportIngest.sink;
  if (sink && (courseId === undefined || sink.courseId === courseId)) return;
  installFetchHook();
  armed = { unsubscribe: onFetch(onPreStartFetch), queue: [], dropped: 0 };
  ingestTrace("arm");
}

/** Drop the buffer unread (the flag is off, or the route isn't listed after all). */
export function disarmIngest(): void {
  if (!armed) return;
  armed.unsubscribe();
  armed = null;
  ingestTrace("disarm");
}

declare global {
  interface Window {
    /** E2E builds only: when the pre-start buffer was armed, disarmed, and drained. */
    __bugReportIngestTrace?: { event: string; at: number }[];
  }
}

/** Records an arming event for the E2E tests. A build-time no-op outside E2E builds. */
export function ingestTrace(event: string): void {
  if (process.env.BUG_REPORT_E2E !== "true" || typeof window === "undefined") return;
  (window.__bugReportIngestTrace ??= []).push({ event, at: Math.round(performance.now()) });
}

export function isIngestArmed(): boolean {
  return armed !== null;
}

/** Hand the buffered responses to the starting ingest and stop buffering. */
export function takeBufferedResponses(): { responses: BufferedResponse[]; dropped: number } {
  if (!armed) return { responses: [], dropped: 0 };
  const { queue, dropped } = armed;
  ingestTrace(`take ${queue.length}`);
  disarmIngest();
  return { responses: queue, dropped };
}
