/**
 * Uploads a reviewed, redacted recording as a Sentry replay: one envelope per segment, each a
 * `replay_event` plus a `replay_recording`, sent one after another through Sentry's fetch
 * transport to the client's endpoint (so through /api/tunnel). Called only from
 * `submitReport`, after the user presses Submit; nothing here runs before that.
 *
 * The envelopes follow the SDK's own replay integration (`createReplayEnvelope` and
 * `prepareReplayEvent` in @sentry-internal/replay 10.3.0), which is not installed (spec §3).
 */
import * as Sentry from "@sentry/nextjs";
import {
  createEnvelope,
  createEventEnvelopeHeaders,
  getEnvelopeEndpointWithUrlEncodedAuth,
  getSdkMetadataForEnvelopeHeader,
  isRateLimited,
  parseRetryAfterHeader,
  prepareEvent,
  updateRateLimits,
  type RateLimits,
  type ReplayEnvelope,
  type ReplayEvent,
  type TransportMakeRequestResponse
} from "@sentry/core";
import { getActiveRecorder } from "../activeRecorder";
import { getReportContext } from "../reportContext";
import type { ReplayUploadResult } from "../submitFeedback";
import type { FrozenBuffer } from "../types";
import {
  deflate,
  MAX_SEGMENT_COMPRESSED_BYTES,
  planSegments,
  recordingPayload,
  type Compressor,
  type DroppedRange,
  type PreparedSegment
} from "./segments";

/**
 * The report tags that also go on every replay event (spec §6 package 6), as `buildReportTags`
 * makes them. Other keys are ignored.
 */
export type ReportContextTags = Record<string, string>;
const REPLAY_TAG_KEYS = ["class_id", "role", "route", "release", "contact_ok"] as const;

export type UploadResult = ReplayUploadResult;

export type UploadStats = {
  /** Compressed recording bytes per segment, in segment order. */
  compressedBytes: number[];
  /** Characters of event JSON in the buffer. */
  rawChars: number;
  /** Planning (serialize + compress) and sending, in ms. */
  compressMs: number;
  sendMs: number;
  /** Send attempts per segment, in segment order (1 = no retry). */
  attempts: number[];
};

/** What segments are sent through: a transport's `send`, given the attempt's abort signal. */
export type SegmentTransport = {
  send(envelope: ReplayEnvelope, init: { signal: AbortSignal }): PromiseLike<TransportMakeRequestResponse>;
};

export type UploadOptions = {
  /** Aborting cancels the request in flight (or the next send) and yields `failed`, with no retry. */
  signal?: AbortSignal;
  /** Called once the upload finishes, successful or not. For measurements and tests. */
  onStats?: (stats: UploadStats) => void;
  /** Test hooks. Production callers leave these unset. */
  sleep?: (ms: number) => Promise<void>;
  compress?: Compressor;
  maxSegmentCompressedBytes?: number;
  transport?: SegmentTransport;
};

/** Tries per segment, including the first. */
export const MAX_ATTEMPTS = 3;
/** Backoff before the 2nd and 3rd try: 1 s, then 2 s. */
export const RETRY_BASE_DELAY_MS = 1000;
/**
 * Longest wait a 5xx's `Retry-After` can ask for between tries. A longer ask still gets this
 * wait: the report shouldn't hang for minutes, and once the tries run out the feedback goes
 * without the replay.
 */
export const MAX_RETRY_AFTER_MS = 10_000;
/**
 * Longest one send attempt may take. A request still open after this is aborted and counts
 * as a retryable failure, like a network error.
 */
export const SEND_TIMEOUT_MS = 30_000;

/**
 * Rate limits Sentry announced to an earlier upload in this page load. The transport keeps its
 * own and silently drops rate-limited items (answering `{}`); this copy lets a later report
 * say "try again later" at once instead of retrying into the drop.
 */
let rateLimits: RateLimits = {};

/** Test-only reset. */
export function resetUploadStateForTests(): void {
  rateLimits = {};
}

type Client = NonNullable<ReturnType<typeof Sentry.getClient>>;

const transports = new WeakMap<Client, SegmentTransport>();

/**
 * The client's own transport, rebuilt with `keepalive` off.
 *
 * The browser fetch transport sets `keepalive` on bodies up to 60 KB. Chromium counts a
 * keepalive request against its 64 KiB in-flight quota until the response body is read, and
 * the transport never reads it. So a few small segments sent back to back (or a retry right
 * after a failure) fail with "Failed to fetch" before reaching the network, and so does the
 * feedback that follows them through the client's transport. Seen in F6; reproduced with
 * plain `fetch(..., {keepalive: true})`. The upload runs while the page is open, so it gains
 * nothing from keepalive. Same URL (the tunnel), headers and fetch implementation as the
 * client's transport; rate limits are tracked here (`rateLimits`), not shared with it.
 */
function replayTransport(client: Client): SegmentTransport {
  let transport = transports.get(client);
  if (!transport) {
    const options = client.getOptions();
    const transportOptions = (options.transportOptions ?? {}) as { fetchOptions?: RequestInit };
    const fetchOptions: RequestInit = { ...transportOptions.fetchOptions, keepalive: false };
    const inner = Sentry.makeFetchTransport({
      tunnel: options.tunnel,
      recordDroppedEvent: client.recordDroppedEvent.bind(client),
      ...transportOptions,
      url: getEnvelopeEndpointWithUrlEncodedAuth(client.getDsn()!, options.tunnel, options._metadata?.sdk),
      fetchOptions
    });
    transport = {
      send(envelope, { signal }) {
        // The fetch transport spreads `fetchOptions` into the request inside send(), before it
        // returns (createTransport's promise buffer starts the request at once). So a signal
        // set around the call reaches this request only. Segments are sent one at a time.
        fetchOptions.signal = signal;
        try {
          return inner.send(envelope);
        } finally {
          delete fetchOptions.signal;
        }
      }
    };
    transports.set(client, transport);
  }
  return transport;
}

type Outcome = "ok" | "retry" | "permanent" | "rate_limited";

function classify(response: TransportMakeRequestResponse | undefined): Outcome {
  const status = response?.statusCode;
  // No status: the transport dropped the envelope without sending it (rate limited earlier,
  // or its queue was full). Not a success, and possibly transient.
  if (status === undefined) return isRateLimited(rateLimits, "replay") ? "rate_limited" : "retry";
  if (status >= 200 && status < 300) return "ok";
  if (status === 429) return "rate_limited";
  // 413 (too large) and other 4xx won't change on a retry.
  if (status < 500) return "permanent";
  return "retry";
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Builds a segment's replay_event. `prepareEvent` adds release, environment, dist and the SDK
 * name, as the SDK's replay integration does; then only the fields a replay needs are kept.
 * Scope data (breadcrumbs from the SDK's default integrations, extra, contexts, fingerprint)
 * has not been through redaction, so none of it rides along.
 */
async function buildReplayEvent(
  client: Client,
  buffer: FrozenBuffer,
  segment: PreparedSegment,
  replayStartTimestamp: number,
  tags: Record<string, string>
): Promise<ReplayEvent | null> {
  const base: ReplayEvent = {
    type: "replay_event",
    replay_id: buffer.replayId,
    segment_id: segment.segmentId,
    replay_type: "buffer",
    replay_start_timestamp: replayStartTimestamp / 1000,
    timestamp: segment.endTimestamp / 1000,
    // The full lists go on segment 0, which is sent first; Sentry merges them across segments.
    urls: segment.segmentId === 0 ? buffer.urls : [],
    error_ids: segment.segmentId === 0 ? buffer.errorIds : [],
    trace_ids: segment.segmentId === 0 ? buffer.traceIds : []
  };
  const options = client.getOptions();
  const prepared = await prepareEvent(
    options,
    base,
    { event_id: buffer.replayId, integrations: [] },
    Sentry.getCurrentScope(),
    client,
    Sentry.getIsolationScope()
  );
  if (!prepared) return null;

  const sdk = client.getSdkMetadata()?.sdk;
  // Admin pages never call Sentry.setUser; the report context has the ID there.
  const userId = prepared.user?.id ?? getReportContext().userId;
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : undefined;
  const event: ReplayEvent = {
    ...base,
    event_id: buffer.replayId,
    timestamp: base.timestamp,
    platform: "javascript",
    release: prepared.release,
    environment: prepared.environment,
    dist: prepared.dist,
    tags,
    // ID only (ADR 3). `ip_address: null` keeps the SDK from sending "{{auto}}", but it does
    // not stop relay: on the dev Sentry the stored replay and feedback still get `user.ip`
    // from the ingress address. Only the org or project setting "Prevent storing of IP
    // addresses" stops that, and turning it on is a human task. F7 reports whether an IP
    // was stored (and fails on it with BUG_REPORT_REQUIRE_NO_IP=1).
    user: { ...(userId !== undefined ? { id: String(userId) } : {}), ip_address: null },
    sdk: { name: sdk?.name ?? "sentry.javascript.unknown", version: sdk?.version ?? "0.0.0", integrations: [] },
    ...(userAgent ? { request: { headers: { "User-Agent": userAgent } } } : {}),
    contexts: {}
  };
  return event;
}

function replayEnvelope(client: Client, event: ReplayEvent, payload: Uint8Array): ReplayEnvelope {
  return createEnvelope<ReplayEnvelope>(
    createEventEnvelopeHeaders(
      event,
      getSdkMetadataForEnvelopeHeader(event),
      client.getOptions().tunnel,
      client.getDsn()
    ),
    [
      [{ type: "replay_event" }, event],
      [{ type: "replay_recording", length: payload.length }, payload]
    ]
  );
}

/**
 * Sends one segment, retrying 5xx, network errors and transport drops with exponential
 * backoff, up to MAX_ATTEMPTS tries. A 5xx's `Retry-After` stretches the wait (up to
 * MAX_RETRY_AFTER_MS). The fetch transport also reads that header as its own limit and drops
 * sends until it passes; after a longer ask the next try comes back as a drop (no status),
 * which counts as one more retry, so the tries still run out into `failed`.
 */
async function sendSegment(
  transport: SegmentTransport,
  envelope: ReplayEnvelope,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined
): Promise<{ outcome: Exclude<Outcome, "retry"> | "failed"; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) return { outcome: "failed", attempts: attempt - 1 };
    if (isRateLimited(rateLimits, "replay")) return { outcome: "rate_limited", attempts: attempt - 1 };
    let outcome: Outcome | "aborted";
    let retryAfterMs = 0;
    // One controller per attempt, aborted by the timeout or by the caller's signal. It aborts
    // the fetch, and the race below stops waiting even for a transport that ignores it.
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    const timer = setTimeout(abortAttempt, SEND_TIMEOUT_MS);
    signal?.addEventListener("abort", abortAttempt);
    const stopped = new Promise<never>((_, reject) =>
      attemptController.signal.addEventListener("abort", () => reject(new Error("send aborted")), { once: true })
    );
    try {
      const response = await Promise.race([transport.send(envelope, { signal: attemptController.signal }), stopped]);
      recordRateLimits(response);
      outcome = classify(response);
      const retryAfter = response?.headers?.["retry-after"];
      if (outcome === "retry" && retryAfter) retryAfterMs = parseRetryAfterHeader(retryAfter);
    } catch {
      // fetch rejected (offline, DNS, connection reset) or the attempt timed out: retry. The
      // caller aborting is the exception.
      outcome = signal?.aborted ? "aborted" : "retry";
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortAttempt);
    }
    if (outcome === "aborted") return { outcome: "failed", attempts: attempt };
    if (outcome !== "retry") return { outcome, attempts: attempt };
    if (attempt >= MAX_ATTEMPTS) return { outcome: "failed", attempts: attempt };
    const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    await sleep(Math.max(backoff, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)));
  }
}

/**
 * Keeps the limits Sentry announces on a 429, or in `X-Sentry-Rate-Limits` on a success. A 5xx
 * is left out: `updateRateLimits` reads its `Retry-After` as a limit on every category, which
 * would turn a transient server error into "try again later" for the whole report. A 5xx's
 * `Retry-After` is only the wait before the next try (see `sendSegment`).
 */
function recordRateLimits(response: TransportMakeRequestResponse | undefined): void {
  const status = response?.statusCode;
  if (status === 429) rateLimits = updateRateLimits(rateLimits, response!);
  else if (status !== undefined && status >= 200 && status < 300) {
    const header = response?.headers?.["x-sentry-rate-limits"];
    if (header) {
      rateLimits = updateRateLimits(rateLimits, {
        statusCode: status,
        headers: { "x-sentry-rate-limits": header, "retry-after": null }
      });
    }
  }
}

function pickTags(ctx: ReportContextTags): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const key of REPLAY_TAG_KEYS) if (ctx[key] !== undefined) tags[key] = ctx[key];
  return tags;
}

/**
 * Uploads `buffer` (already redacted) as replay `buffer.replayId`. Segments go out in order and
 * each must get a 2xx before the next is sent. The result says whether the feedback may point
 * at the replay:
 * - `ok`: every segment was accepted.
 * - `rate_limited`: Sentry answered 429; stop the whole report and ask the user to retry later.
 * - `failed`: retries ran out, a permanent error (413, other 4xx), nothing to upload, or aborted.
 *   Segments sent before the failure stay in Sentry as a partial replay nobody links to.
 */
export async function uploadReplay(
  buffer: FrozenBuffer,
  ctx: ReportContextTags,
  opts: UploadOptions = {}
): Promise<UploadResult> {
  const { signal, onStats, sleep = defaultSleep, compress = deflate } = opts;
  const max = opts.maxSegmentCompressedBytes ?? MAX_SEGMENT_COMPRESSED_BYTES;
  const replayId = buffer.replayId;
  const stats: UploadStats = { compressedBytes: [], rawChars: buffer.size, compressMs: 0, sendMs: 0, attempts: [] };
  const finish = (result: UploadResult): UploadResult => {
    onStats?.(stats);
    return result;
  };

  const client = Sentry.getClient();
  if (!client || !client.getDsn()) return finish({ ok: false, reason: "failed", replayId });
  const transport = opts.transport ?? replayTransport(client);
  if (isRateLimited(rateLimits, "replay")) return finish({ ok: false, reason: "rate_limited", replayId });

  const t0 = performance.now();
  const plan = await planSegments(buffer, compress, max);
  stats.compressMs = performance.now() - t0;
  stats.compressedBytes = plan.segments.map((s) => s.compressed.length);
  if (plan.segments.length === 0) return finish({ ok: false, reason: "failed", replayId });

  const tags = pickTags(ctx);
  const replayStart = plan.segments[0].startTimestamp;
  const t1 = performance.now();
  try {
    for (const segment of plan.segments) {
      const event = await buildReplayEvent(client, buffer, segment, replayStart, tags);
      if (!event) return finish({ ok: false, reason: "failed", replayId });
      const envelope = replayEnvelope(client, event, recordingPayload(segment));
      const { outcome, attempts } = await sendSegment(transport, envelope, sleep, signal);
      stats.attempts.push(attempts);
      if (outcome === "rate_limited") return finish({ ok: false, reason: "rate_limited", replayId });
      if (outcome !== "ok") return finish({ ok: false, reason: "failed", replayId });
    }
  } finally {
    stats.sendMs = performance.now() - t1;
    // Segments may be in Sentry under this ID now, so the next report in this page load must
    // not reuse it: its segment 0 would overwrite this one's. A retry of this report keeps the
    // ID, since it uses the same frozen buffer.
    if (stats.attempts.length > 0) getActiveRecorder()?.rotateReplayId(replayId);
  }
  return finish({
    ok: true,
    replayId,
    segments: plan.segments.length,
    ...(plan.dropped.length ? { dropped: summarizeDropped(plan.dropped) } : {})
  });
}

function summarizeDropped(dropped: DroppedRange[]): { events: number; ms: number } {
  return {
    events: dropped.reduce((n, d) => n + d.events, 0),
    ms: dropped.reduce((n, d) => n + (d.to - d.from), 0)
  };
}

/** The `ReportReplayUpload` that `submitReport` calls on Submit, for one frozen buffer. */
export function createReplayUpload(
  buffer: FrozenBuffer,
  opts: UploadOptions = {}
): { upload(tags: ReportContextTags): Promise<UploadResult> } {
  return { upload: (tags) => uploadReplay(buffer, tags, opts) };
}
