/**
 * `sentryApi`: a small client for the dev Sentry's web API (`$SENTRY_URL/api/0/...`), used by the
 * nightly and release tiers to check what actually landed (spec §7.2).
 *
 * Reads SENTRY_URL, SENTRY_ORG, SENTRY_PROJECT and SENTRY_AUTH_TOKEN from the environment. The
 * token is only ever sent in the Authorization header; nothing here logs it or any response body
 * that could contain it.
 */

export class SentryInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SentryInfrastructureError";
  }
}

export type SentryApiConfig = { url: string; org: string; project: string; token: string };

export function sentryApiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SentryApiConfig | null {
  const { SENTRY_URL, SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN } = env;
  if (!SENTRY_URL || !SENTRY_ORG || !SENTRY_PROJECT || !SENTRY_AUTH_TOKEN) return null;
  return { url: SENTRY_URL.replace(/\/+$/, ""), org: SENTRY_ORG, project: SENTRY_PROJECT, token: SENTRY_AUTH_TOKEN };
}

/** A Sentry event as the event-details endpoint returns it (the fields the tests read). */
export type SentryEvent = {
  id: string;
  eventID: string;
  groupID?: string;
  release?: { version: string } | null;
  user?: Record<string, unknown> | null;
  tags: { key: string; value: string }[];
  contexts?: Record<string, Record<string, unknown>>;
  entries: { type: string; data: unknown }[];
  [key: string]: unknown;
};

export type SentryFrame = {
  filename?: string;
  absPath?: string;
  function?: string;
  lineNo?: number;
  colNo?: number;
  inApp?: boolean;
  context?: [number, string][];
  [key: string]: unknown;
};

/** The frames of every exception in an event, innermost last. */
export function exceptionFrames(event: SentryEvent): SentryFrame[] {
  const entry = event.entries.find((e) => e.type === "exception");
  const values = (entry?.data as { values?: { stacktrace?: { frames?: SentryFrame[] } }[] })?.values ?? [];
  return values.flatMap((v) => v.stacktrace?.frames ?? []);
}

export class SentryApi {
  constructor(readonly config: SentryApiConfig) {}

  /** Fetches `path` (relative to /api/0/) and parses JSON. 404 resolves to null. */
  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T | null> {
    const url = new URL(`${this.config.url}/api/0/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.append(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${this.config.token}` } });
    } catch (e) {
      throw new SentryInfrastructureError(`Sentry API unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Sentry API ${url.pathname} answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** GET and return raw bytes (recording segments). 404 resolves to null. */
  async getBytes(path: string, query: Record<string, string> = {}): Promise<Uint8Array | null> {
    const url = new URL(`${this.config.url}/api/0/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.config.token}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Sentry API ${url.pathname} answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private get org() {
    return encodeURIComponent(this.config.org);
  }
  private get project() {
    return encodeURIComponent(this.config.project);
  }

  /** One event by ID in the configured project, or null if it hasn't been processed yet. */
  event(eventId: string): Promise<SentryEvent | null> {
    return this.get<SentryEvent>(`projects/${this.org}/${this.project}/events/${eventId.replace(/-/g, "")}/`);
  }

  /** Issues matching a search query, e.g. `release:x` or `issue.category:feedback`. */
  issues(query: string, extra: Record<string, string> = {}) {
    return this.get<Record<string, unknown>[]>(`projects/${this.org}/${this.project}/issues/`, { query, ...extra });
  }

  /** Events of an issue, newest first. */
  issueEvents(issueId: string, full = true) {
    return this.get<SentryEvent[]>(`organizations/${this.org}/issues/${issueId}/events/`, { full: String(full) });
  }

  /** User feedback items (feedback issues) matching `query`. */
  feedback(query = "") {
    return this.issues(`issue.category:feedback ${query}`.trim());
  }

  /** Replays in the configured project matching `query`. */
  async replays(query = "", statsPeriod = "24h") {
    const projectInfo = await this.get<{ id: string }>(`projects/${this.org}/${this.project}/`);
    return this.get<{ data: Record<string, unknown>[] }>(`organizations/${this.org}/replays/`, {
      project: projectInfo?.id,
      query,
      statsPeriod
    });
  }

  /** One replay's metadata. */
  replay(replayId: string) {
    return this.get<{ data: Record<string, unknown> }>(
      `organizations/${this.org}/replays/${replayId.replace(/-/g, "")}/`
    );
  }

  /** The recording segments of a replay, as uploaded (decompressed by Sentry), as raw bytes. */
  recordingSegments(replayId: string) {
    return this.getBytes(
      `projects/${this.org}/${this.project}/replays/${replayId.replace(/-/g, "")}/recording-segments/`,
      {
        download: "true"
      }
    );
  }

  /**
   * Polls `fn` until it returns a non-null value. After `timeoutMs` (60 s, the spec's limit for
   * a smoke event) throws SentryInfrastructureError: an event that doesn't show up is an ingest
   * fault to report to the human, not a product bug to retry around (spec §1.1).
   */
  async waitFor<T>(
    what: string,
    fn: () => Promise<T | null | undefined>,
    { timeoutMs = 60_000, intervalMs = 2_000 } = {}
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await fn();
      if (value !== null && value !== undefined) return value;
      if (Date.now() >= deadline) {
        throw new SentryInfrastructureError(
          `${what} did not appear in Sentry within ${Math.round(timeoutMs / 1000)} s. Stop and report this as an ` +
            "infrastructure fault (e.g. relay accepting but not forwarding); do not retry."
        );
      }
      // Real wall-clock wait: this is polling a remote server, not browser time, so page.clock
      // doesn't apply.
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/** A client from the environment, or null when the Sentry variables aren't set (PR tier). */
export function sentryApiFromEnv(): SentryApi | null {
  const config = sentryApiConfigFromEnv();
  return config ? new SentryApi(config) : null;
}
