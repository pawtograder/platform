import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import { inflateSync } from "node:zlib";
import {
  parseEnvelope,
  splitReplayRecording,
  type EnvelopeHeader,
  type EnvelopeItem,
  type ParsedEnvelope
} from "@/lib/bugReport/envelope";

/**
 * `captureTunnel(page)`: intercepts `POST /api/tunnel` and parses every envelope the browser
 * sends (spec §7.2). In the PR tier (the default) it answers 200 itself and nothing leaves the
 * machine. With `forward: true` the request continues to the real route, which is how the
 * nightly and release tiers reach the dev Sentry.
 *
 * It also records the body of every other request the context makes, so
 * `assertNoReplayUploaded` can check that no replay data left by some other path (a beacon, a
 * keepalive fetch, a second tunnel).
 */

export type CapturedItem = EnvelopeItem & {
  /** For `replay_recording`: the `{"segment_id":n}` line */
  segmentHeader?: { segment_id?: number };
  /** For `replay_recording`: the recording bytes after the first line, inflated if compressed */
  recording?: Uint8Array;
  /** For `replay_recording`: the parsed rrweb events, when the recording is JSON */
  recordingEvents?: unknown[];
};

export type CapturedEnvelope = {
  header: EnvelopeHeader;
  items: CapturedItem[];
  /** The raw request body, exactly as the browser sent it */
  raw: Uint8Array;
  url: string;
  /** Status the fixture answered with (or the real route returned, when forwarding) */
  status?: number;
  /** Set when the body didn't parse as an envelope */
  parseError?: string;
};

export type CapturedRequest = { method: string; url: string; resourceType: string; body: Uint8Array | null };

export type TunnelResponder = (
  envelope: CapturedEnvelope,
  index: number
) => { status: number; headers?: Record<string, string>; body?: string } | "forward" | undefined;

export type TunnelCapture = {
  /** Every envelope posted to /api/tunnel, in order */
  readonly envelopes: CapturedEnvelope[];
  /** Every request the context made (tunnel included), with its body */
  readonly requests: CapturedRequest[];
  /** All items of a type, across envelopes */
  items(type: string): CapturedItem[];
  /** Every uploaded byte, for canary scans: each item payload, with recordings inflated */
  uploadedBytes(): Uint8Array[];
  /** Resolves with the first envelope matching `predicate`, waiting up to `timeoutMs` */
  waitForEnvelope(predicate: (e: CapturedEnvelope) => boolean, timeoutMs?: number): Promise<CapturedEnvelope>;
  /** Removes the route and listeners */
  stop(): Promise<void>;
};

const TUNNEL_PATTERN = "**/api/tunnel";
const decoder = new TextDecoder();

/** Inflates `bytes` if it is a zlib stream (starts with 0x78), else null. */
function tryInflate(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 2 || bytes[0] !== 0x78) return null;
  try {
    return new Uint8Array(inflateSync(bytes));
  } catch {
    return null;
  }
}

/** The recording may be zlib-compressed or plain JSON. */
function inflateIfCompressed(bytes: Uint8Array): Uint8Array {
  return tryInflate(bytes) ?? bytes;
}

/** An item's payload parsed as JSON, or undefined if it isn't JSON. */
export function payloadJsonOf<T = Record<string, unknown>>(item: EnvelopeItem): T | undefined {
  try {
    return JSON.parse(decoder.decode(item.payload)) as T;
  } catch {
    return undefined;
  }
}

/** Parses a tunnel request body into a CapturedEnvelope. Exported for unit tests. */
export function parseCapturedEnvelope(raw: Uint8Array, url = "/api/tunnel"): CapturedEnvelope {
  let parsed: ParsedEnvelope;
  try {
    parsed = parseEnvelope(raw);
  } catch (e) {
    return { header: {}, items: [], raw, url, parseError: e instanceof Error ? e.message : String(e) };
  }
  const items: CapturedItem[] = parsed.items.map((item) => {
    if (item.header.type !== "replay_recording") return item;
    const { segmentHeader, body } = splitReplayRecording(item.payload);
    const recording = inflateIfCompressed(body);
    let recordingEvents: unknown[] | undefined;
    try {
      const json = JSON.parse(decoder.decode(recording));
      if (Array.isArray(json)) recordingEvents = json;
    } catch {
      // not JSON; leave recordingEvents unset
    }
    return { ...item, segmentHeader, recording, recordingEvents };
  });
  return { header: parsed.header, items, raw, url };
}

export async function captureTunnel(
  page: Page,
  options: { forward?: boolean; respond?: TunnelResponder } = {}
): Promise<TunnelCapture> {
  const context: BrowserContext = page.context();
  const envelopes: CapturedEnvelope[] = [];
  const requests: CapturedRequest[] = [];
  const waiters: { predicate: (e: CapturedEnvelope) => boolean; resolve: (e: CapturedEnvelope) => void }[] = [];

  const onRequest = (request: Request) => {
    const body = request.postDataBuffer();
    requests.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      body: body ? new Uint8Array(body) : null
    });
  };
  context.on("request", onRequest);

  const handler = async (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const body = request.postDataBuffer();
    const envelope = parseCapturedEnvelope(body ? new Uint8Array(body) : new Uint8Array(), request.url());
    const index = envelopes.length;
    envelopes.push(envelope);

    const decision = options.respond?.(envelope, index) ?? (options.forward ? "forward" : undefined);
    if (decision === "forward") {
      const response = await route.fetch();
      envelope.status = response.status();
      await route.fulfill({ response });
    } else {
      const answer = decision ?? { status: 200, body: "{}" };
      envelope.status = answer.status;
      await route.fulfill({
        status: answer.status,
        headers: { "content-type": "application/json", ...(answer.headers ?? {}) },
        body: answer.body ?? "{}"
      });
    }

    for (const waiter of [...waiters]) {
      if (waiter.predicate(envelope)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(envelope);
      }
    }
  };
  await context.route(TUNNEL_PATTERN, handler);

  return {
    envelopes,
    requests,
    items: (type) => envelopes.flatMap((e) => e.items.filter((i) => i.header.type === type)),
    uploadedBytes: () =>
      envelopes.flatMap((e) =>
        e.parseError
          ? [e.raw]
          : e.items.map((i) => (i.header.type === "replay_recording" ? (i.recording ?? i.payload) : i.payload))
      ),
    waitForEnvelope: (predicate, timeoutMs = 20_000) => {
      const existing = envelopes.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) {
            waiters.splice(i, 1);
            reject(new Error(`No matching envelope within ${timeoutMs} ms (${envelopes.length} captured)`));
          }
        }, timeoutMs);
      });
    },
    stop: async () => {
      context.off("request", onRequest);
      await context.unroute(TUNNEL_PATTERN, handler);
    }
  };
}

/** Item types that only a replay upload produces. */
const REPLAY_ITEM_TYPES = new Set(["replay_event", "replay_recording", "replay_video"]);

/**
 * Text that appears in serialized rrweb events (`{type, data, timestamp}`): a Meta event (type 4,
 * data.href), a FullSnapshot (type 2, data.node), or an IncrementalSnapshot (type 3,
 * data.source); or a replay segment header.
 */
const RRWEB_MARKERS: RegExp[] = [
  /"type"\s*:\s*[234]\s*,\s*"data"\s*:\s*\{\s*"(?:node|source|href)"/,
  /"segment_id"\s*:\s*\d+/
];

/** Why a body looks like replay data, or null. Also looks inside any zlib stream in the body. */
export function rrwebMarkerIn(body: Uint8Array): string | null {
  const candidates = [body];
  const whole = tryInflate(body);
  if (whole) candidates.push(whole);
  // A compressed recording sits after a JSON line inside an envelope, so try after each newline.
  for (let i = body.indexOf(0x0a); i !== -1; i = body.indexOf(0x0a, i + 1)) {
    const tail = tryInflate(body.subarray(i + 1));
    if (tail) candidates.push(tail);
  }
  for (const bytes of candidates) {
    const text = decoder.decode(bytes);
    for (const marker of RRWEB_MARKERS) {
      if (marker.test(text)) return `matches ${marker}`;
    }
    if (text.includes('"childNodes"') && text.includes('"rootId"')) return "contains an rrweb node tree";
  }
  return null;
}

/**
 * Fails unless nothing replay-related was uploaded: no `replay_event` / `replay_recording` item in
 * any tunnel envelope, and no request body anywhere that carries rrweb events (spec §7.2).
 */
export function assertNoReplayUploaded(capture: TunnelCapture): void {
  const problems: string[] = [];
  capture.envelopes.forEach((envelope, i) => {
    for (const item of envelope.items) {
      if (REPLAY_ITEM_TYPES.has(item.header.type)) problems.push(`envelope ${i}: ${item.header.type} item`);
    }
    // An error event may carry replay_id in its trace context (B1); anything more is a replay.
    if (envelope.parseError) {
      const why = rrwebMarkerIn(envelope.raw);
      if (why) problems.push(`envelope ${i} (unparseable): ${why}`);
    }
  });
  for (const request of capture.requests) {
    if (!request.body) continue;
    const why = rrwebMarkerIn(request.body);
    if (why) problems.push(`${request.method} ${request.url}: ${why}`);
  }
  if (problems.length > 0) {
    throw new Error(`Replay data was uploaded:\n  ${problems.join("\n  ")}`);
  }
}
