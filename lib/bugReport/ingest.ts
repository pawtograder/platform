/**
 * The taint ingest (bug reporter spec, package 2): classifies data as it reaches the browser and
 * adds the PII in it to this page load's taint set, while a recorder exists.
 *
 * Five ingest points feed it:
 *
 * 1. fetch: every Supabase REST, RPC, edge-function, and auth response, and every `/api/` response,
 *    through `classifyResponse`. The hook is package 1's `fetchHook`, installed by
 *    `utils/supabase/client.ts` before the browser client captures `fetch`. Responses that arrived
 *    before the recorder chunk loaded come from the pre-start buffer in `ingestGate.ts`.
 * 2. TableController: `initialData`, `_addRow`, `_updateRow` through `bugReportIngest.sink`, plus
 *    the rows every live controller already holds when the ingest starts.
 * 3. Realtime: broadcasts routed by RealtimeChannelManager and the two `postgres_changes`
 *    listeners (classes, meeting windows). ID-only broadcasts make the controller refetch, which
 *    comes back through the fetch hook.
 * 4. The taint block, read by the recorder at start and on each navigation (`readTaintBlocks`).
 * 5. The auth session: the user's own email, `user_metadata`, and identity data.
 *
 * What gets tainted:
 *
 * - `name`, `email`, `handle` values, expanded into variants by the taint set.
 * - `free_text` values, line by line. When the value sat inside a Json or array column
 *   (`nested`), strings that look like enum values are skipped: a single lower-case word of letters
 *   joined by `_` or `-`, at most 16 characters ("open", "in_progress", "check-run"). The same
 *   blobs also skip UUIDs, ISO timestamps, and numbers. A capitalized or digit-bearing word
 *   ("Jane", "octocat42") is kept, so a name or most handles inside a blob still taint.
 * - `grade` values: never. Grades are blocked structurally (package 3).
 * - Unclassified values (a key or path `privacy.ts` doesn't know, an unknown relation, or any
 *   `/api/` body): every string of 3+ characters except UUIDs, timestamps, and numbers, as
 *   `free_text`. This over-redacts on purpose: a schema change that adds a column must not let its
 *   values through before someone classifies it. In development a console warning names the keys
 *   (never the values), once per key.
 *
 * Loaded only from the recorder chunk. Nothing here runs with the course flag off.
 */
import { onFetch } from "./fetchHook";
import {
  bugReportIngest,
  isIngestUrl,
  isJsonResponse,
  liveRowSources,
  MAX_INGEST_BODY_BYTES,
  takeBufferedResponses,
  type IngestSink
} from "./ingestGate";
import { classifyResponse, classifyRows, type ClassifiedValue, type UnclassifiedValue } from "./selectParser";
import { getTaintSet, type TaintKind, type TaintSet, type TaintStats } from "./taint";
import { MIN_MATCH_LENGTH } from "./variants";

export type IngestStats = {
  /** Milliseconds spent classifying and adding to the taint set, main thread. */
  classifyMs: number;
  /** Milliseconds spent reading and parsing cloned response bodies. */
  parseMs: number;
  responses: number;
  /** Row batches from TableControllers and realtime. */
  rowBatches: number;
  broadcasts: number;
  /** Values handed to the taint set (before dedupe and variants). */
  values: number;
  /** Strings from unclassified keys tainted conservatively. */
  unclassifiedValues: number;
  /** Distinct unclassified keys seen. */
  unclassifiedKeys: number;
  /** Bodies not parsed because they were over the size limit. */
  skippedBodies: number;
  /** Pre-start responses dropped because the buffer was full. */
  droppedBuffered: number;
};

export type IngestHandle = {
  stop(): void;
  stats(): IngestStats;
  /** Resolves once every response read so far has been classified. */
  idle(): Promise<void>;
};

/** A Supabase auth user, as `getSession()` and `/auth/v1/user` return it (loosely typed). */
type AuthUserLike = {
  email?: unknown;
  phone?: unknown;
  user_metadata?: unknown;
  identities?: unknown;
};

export type StartIngestOptions = {
  /** The session's user. Defaults to the browser Supabase client's `auth.getSession()`. */
  getSessionUser?: () => Promise<AuthUserLike | null | undefined>;
  set?: TaintSet;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const NUMERIC = /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const ENUM_LIKE = /^[a-z]+(?:[_-][a-z]+)*$/;
export const ENUM_LIKE_MAX_LENGTH = 16;

/** UUIDs, ISO dates and timestamps, and numbers: never a name, email, or handle. */
export function isStructuralValue(value: string): boolean {
  const v = value.trim();
  return UUID.test(v) || ISO_TIME.test(v) || NUMERIC.test(v);
}

/** A single lower-case word, maybe joined by `_` or `-`, at most 16 characters: an enum value. */
export function isEnumLike(value: string): boolean {
  const v = value.trim();
  return v.length <= ENUM_LIKE_MAX_LENGTH && ENUM_LIKE.test(v);
}

/** Auth `user_metadata` / `identity_data` keys and their kinds; other string keys are unclassified. */
const AUTH_METADATA_KINDS: Record<string, TaintKind | "none"> = {
  name: "name",
  full_name: "name",
  given_name: "name",
  family_name: "name",
  email: "email",
  user_name: "handle",
  preferred_username: "handle",
  nickname: "handle",
  login: "handle",
  avatar_url: "handle",
  picture: "handle",
  sub: "none",
  provider_id: "none",
  iss: "none",
  email_verified: "none",
  phone_verified: "none"
};

const isDev = process.env.NODE_ENV !== "production";

class Ingest implements IngestSink {
  private readonly set: TaintSet;
  private readonly warned = new Set<string>();
  private pending = new Set<Promise<void>>();
  private stopped = false;
  private unsubscribeFetch: (() => void) | undefined;
  readonly counters: IngestStats = {
    classifyMs: 0,
    parseMs: 0,
    responses: 0,
    rowBatches: 0,
    broadcasts: 0,
    values: 0,
    unclassifiedValues: 0,
    unclassifiedKeys: 0,
    skippedBodies: 0,
    droppedBuffered: 0
  };

  constructor(set: TaintSet) {
    this.set = set;
  }

  start(options: StartIngestOptions): void {
    bugReportIngest.sink = this;
    this.unsubscribeFetch = onFetch((o) => {
      if (!o.response || !isIngestUrl(o.url) || !isJsonResponse(o.response)) return;
      let clone: Response;
      try {
        clone = o.response.clone();
      } catch {
        return;
      }
      this.track(this.ingestResponse(o.method, o.url, clone));
    });
    const { responses, dropped } = takeBufferedResponses();
    this.counters.droppedBuffered += dropped;
    for (const r of responses) this.track(this.ingestResponse(r.method, r.url, r.response));
    for (const source of liveRowSources()) {
      const snapshot = source.bugReportRows();
      if (snapshot && snapshot.rows.length > 0) this.rows(snapshot.relation, snapshot.rows, snapshot.select);
    }
    const getUser = options.getSessionUser ?? defaultSessionUser;
    this.track(
      getUser()
        .then((user) => {
          if (user && !this.stopped) this.timed(() => this.ingestAuthUser(user));
        })
        .catch(() => {
          // No session: nothing of the user's own to add.
        })
    );
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribeFetch?.();
    if (bugReportIngest.sink === this) bugReportIngest.sink = null;
  }

  idle(): Promise<void> {
    return Promise.all([...this.pending]).then(() => (this.pending.size > 0 ? this.idle() : undefined));
  }

  private track(p: Promise<void>): void {
    const tracked = p.catch(() => undefined).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  private timed(fn: () => void): void {
    const started = performance.now();
    try {
      fn();
    } catch {
      // A malformed payload adds nothing; the app must not notice.
    } finally {
      this.counters.classifyMs += performance.now() - started;
    }
  }

  // IngestSink

  rows(relation: string, rows: unknown, select?: string | null): void {
    if (this.stopped || rows === null || rows === undefined) return;
    this.counters.rowBatches++;
    this.timed(() => {
      const result = select
        ? classifyResponse(`/rest/v1/${encodeURIComponent(relation)}?select=${encodeURIComponent(select)}`, "GET", rows)
        : classifyRows(relation, rows);
      this.addResult(result.values, result.unclassifiedValues, result.unclassified);
    });
  }

  broadcast(message: unknown): void {
    if (this.stopped || !message || typeof message !== "object") return;
    const { table, data } = message as { table?: unknown; data?: unknown };
    // ID-only broadcasts carry no row; the controller's refetch comes back through fetch.
    if (typeof table !== "string" || !data || typeof data !== "object") return;
    this.counters.broadcasts++;
    this.rows(table, data);
  }

  // Responses

  private async ingestResponse(method: string, url: string, response: Response): Promise<void> {
    if (this.stopped) return;
    const started = performance.now();
    let body: unknown;
    try {
      const text = await response.text();
      if (text.length > MAX_INGEST_BODY_BYTES) {
        this.counters.skippedBodies++;
        this.warnOnce(`body:${pathOf(url)}`, `response over ${MAX_INGEST_BODY_BYTES} bytes not classified`);
        return;
      }
      if (text.length === 0) return;
      body = JSON.parse(text);
    } catch {
      return;
    } finally {
      this.counters.parseMs += performance.now() - started;
    }
    if (this.stopped) return;
    this.counters.responses++;
    this.timed(() => this.ingestBody(method, url, body));
  }

  /** Exposed for tests through `ingestBodyForTest`. */
  ingestBody(method: string, url: string, body: unknown): void {
    const path = pathOf(url);
    if (/\/auth\/v1\//.test(path)) {
      const b = body as { user?: unknown } | null;
      const user = b && typeof b === "object" && b.user && typeof b.user === "object" ? b.user : body;
      if (user && typeof user === "object") this.ingestAuthUser(user as AuthUserLike);
      return;
    }
    const result = classifyResponse(url, method, body);
    if (result.handled) {
      this.addResult(result.values, result.unclassifiedValues, result.unclassified);
    } else {
      // `/api/` routes have no classification; every string in them is tainted conservatively.
      const strings: UnclassifiedValue[] = [];
      collectStrings(body, path, strings);
      this.addResult([], strings, []);
    }
  }

  private ingestAuthUser(user: AuthUserLike): void {
    if (typeof user.email === "string") this.add("email", user.email);
    if (typeof user.phone === "string" && user.phone.length > 0) this.add("handle", user.phone);
    this.ingestMetadata(user.user_metadata, "auth.user_metadata");
    if (Array.isArray(user.identities)) {
      for (const identity of user.identities) {
        if (!identity || typeof identity !== "object") continue;
        const i = identity as { email?: unknown; identity_data?: unknown };
        if (typeof i.email === "string") this.add("email", i.email);
        this.ingestMetadata(i.identity_data, "auth.identity_data");
      }
    }
  }

  private ingestMetadata(metadata: unknown, source: string): void {
    if (!metadata || typeof metadata !== "object") return;
    const unclassified: UnclassifiedValue[] = [];
    for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
      const kind = AUTH_METADATA_KINDS[key];
      if (kind === "none") continue;
      if (kind && typeof value === "string") this.add(kind, value);
      else collectStrings(value, `${source}.${key}`, unclassified);
    }
    this.addResult([], unclassified, []);
  }

  // Taint set

  private add(kind: TaintKind, value: string): void {
    this.counters.values++;
    this.set.add(kind, value);
  }

  private addResult(values: ClassifiedValue[], unclassifiedValues: UnclassifiedValue[], unclassified: string[]): void {
    for (const v of values) {
      if (v.kind === "grade") continue;
      if (v.kind === "free_text" && v.nested && (isEnumLike(v.value) || isStructuralValue(v.value))) continue;
      this.add(v.kind, v.value);
    }
    for (const u of unclassifiedValues) {
      if (u.value.trim().length < MIN_MATCH_LENGTH || isStructuralValue(u.value)) continue;
      this.counters.unclassifiedValues++;
      this.add("free_text", u.value);
    }
    for (const key of unclassified) {
      // TableController's own bookkeeping field, not a column.
      if (key.endsWith(".__db_pending")) continue;
      this.warnOnce(key, "unclassified; its strings are tainted as free text");
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (!key.startsWith("body:")) this.counters.unclassifiedKeys++;
    if (isDev) {
      // Keys and paths only, never values.
      // eslint-disable-next-line no-console
      console.warn(`[bug report taint] ${key}: ${message}. Classify it in lib/bugReport/privacy.ts.`);
    }
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return url;
  }
}

function collectStrings(v: unknown, source: string, out: UnclassifiedValue[]): void {
  if (typeof v === "string") {
    if (v.length > 0) out.push({ value: v, source });
  } else if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, source, out);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, source, out);
  }
}

async function defaultSessionUser(): Promise<AuthUserLike | null> {
  const { createClient } = await import("@/utils/supabase/client");
  const { data } = await createClient().auth.getSession();
  return (data.session?.user as AuthUserLike | undefined) ?? null;
}

declare global {
  interface Window {
    /** E2E builds only: the taint set and ingest counters, for the leak tests. */
    __bugReportTaint?: {
      has(value: string): boolean;
      values(): Record<TaintKind, string[]>;
      stats(): { taint: TaintStats; ingest: IngestStats };
      idle(): Promise<void>;
    };
  }
}

let running: Ingest | null = null;

/**
 * Start the ingest for this page load's recorder. Returns the running one if already started.
 * `stop()` detaches it; the recorder clears the taint set itself.
 */
export function startIngest(options: StartIngestOptions = {}): IngestHandle {
  if (!running) {
    const ingest = new Ingest(options.set ?? getTaintSet());
    running = ingest;
    ingest.start(options);
    if (process.env.BUG_REPORT_E2E === "true" && typeof window !== "undefined") {
      const set = options.set ?? getTaintSet();
      window.__bugReportTaint = {
        has: (value) => set.has(value),
        values: () => set.values(),
        stats: () => ({ taint: set.stats(), ingest: { ...ingest.counters } }),
        idle: () => ingest.idle()
      };
    }
  }
  const ingest = running;
  return {
    stop: () => {
      ingest.stop();
      if (running === ingest) running = null;
      if (typeof window !== "undefined") delete window.__bugReportTaint;
    },
    stats: () => ({ ...ingest.counters }),
    idle: () => ingest.idle()
  };
}
