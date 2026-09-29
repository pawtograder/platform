/**
 * Unit tests for the replay upload (package 6): segment planning under the size cap, the
 * replay_event and envelope shape, sequential sending, and retries on an injected clock.
 */
import { deflateSync, inflateSync } from "node:zlib";
import type { FrozenBuffer, FrozenSegment, RecordedEvent } from "@/lib/bugReport/types";

type Response = { statusCode?: number; headers?: Record<string, string | null> };
/** "hang": the request never answers; it rejects only if the fetch's signal aborts. */
type Step = Response | "throw" | "hang";

class FakeTransport {
  sent: unknown[] = [];
  script: Step[] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** The fetch `signal` each send would have used, read when the send starts. */
  signals: (AbortSignal | undefined)[] = [];
  async send(envelope: unknown): Promise<Response> {
    // makeFetchTransport spreads `fetchOptions` into the request synchronously inside send().
    const last = transportOptions[transportOptions.length - 1] as { fetchOptions?: RequestInit } | undefined;
    const signal = last?.fetchOptions?.signal ?? undefined;
    this.signals.push(signal);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Promise.resolve();
      this.sent.push(envelope);
      const step = this.script.shift() ?? { statusCode: 200 };
      if (step === "throw") throw new TypeError("Failed to fetch");
      if (step === "hang") {
        return await new Promise<Response>((_, reject) =>
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        );
      }
      return step;
    } finally {
      this.inFlight--;
    }
  }
  flush() {
    return Promise.resolve(true);
  }
}

const transport = new FakeTransport();
const transportOptions: unknown[] = [];
const client = {
  getOptions: () => ({ release: "rel-1", environment: "test", tunnel: "/api/tunnel", integrations: [] }),
  getDsn: () => ({ protocol: "https", publicKey: "pk", host: "sentry.test", port: "", path: "", projectId: "7" }),
  getTransport: () => transport,
  getSdkMetadata: () => ({ sdk: { name: "sentry.javascript.nextjs", version: "10.3.0" } }),
  getEventProcessors: () => [],
  emit: () => {},
  on: () => () => {},
  recordDroppedEvent: () => {}
};

jest.mock("@sentry/nextjs", () => {
  const core = jest.requireActual("@sentry/core");
  const scope = new core.Scope();
  const isolation = new core.Scope();
  return {
    getClient: () => client,
    makeFetchTransport: (options: unknown) => {
      transportOptions.push(options);
      return transport;
    },
    getCurrentScope: () => scope,
    getIsolationScope: () => isolation,
    __scope: scope
  };
});

import * as SentryMock from "@sentry/nextjs";
import { serializeEnvelope } from "@sentry/core";
import { parseEnvelope, payloadJson, splitReplayRecording } from "@/lib/bugReport/envelope";
import {
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  SEND_TIMEOUT_MS,
  MAX_SEGMENT_COMPRESSED_BYTES,
  planSegments,
  resetUploadStateForTests,
  uploadReplay,
  type Compressor,
  type UploadStats
} from "@/lib/bugReport/upload";

const compress: Compressor = async (bytes) => new Uint8Array(deflateSync(bytes));

let clock = 1_700_000_000_000;
function meta(ts = clock): RecordedEvent {
  return { type: 4, data: { href: "http://localhost/course/1/gradebook", width: 800, height: 600 }, timestamp: ts };
}
function snapshot(ts = clock, filler = ""): RecordedEvent {
  return {
    type: 2,
    data: {
      node: { type: 0, id: 1, childNodes: [{ type: 3, id: 2, textContent: filler || "****" }] },
      initialOffset: { left: 0, top: 0 }
    },
    timestamp: ts
  } as unknown as RecordedEvent;
}
function mutation(ts: number, filler = "*****"): RecordedEvent {
  return {
    type: 3,
    data: { source: 0, texts: [], attributes: [{ id: 2, attributes: { "data-x": filler } }], removes: [], adds: [] },
    timestamp: ts
  } as unknown as RecordedEvent;
}
/** Incompressible filler: random hex. */
function noise(chars: number): string {
  let s = "";
  while (s.length < chars) s += Math.random().toString(16).slice(2);
  return s.slice(0, chars);
}
function checkout(start: number, events: RecordedEvent[]): FrozenSegment {
  const all = [meta(start), snapshot(start + 1), ...events];
  const size = all.reduce((n, e) => n + JSON.stringify(e).length, 0);
  return {
    events: all,
    startTimestamp: start,
    endTimestamp: all[all.length - 1].timestamp,
    size,
    level: "structure"
  };
}
function bufferOf(segments: FrozenSegment[]): FrozenBuffer {
  return {
    replayId: "a".repeat(32),
    level: "structure",
    segments,
    startTimestamp: segments[0]?.startTimestamp ?? 0,
    endTimestamp: segments[segments.length - 1]?.endTimestamp ?? 0,
    urls: ["http://localhost/course/1/gradebook", "http://localhost/course/1/assignments"],
    errorIds: ["e".repeat(32)],
    traceIds: ["f".repeat(32)],
    size: segments.reduce((n, s) => n + s.size, 0)
  };
}

const tags = {
  class_id: "1",
  role: "student",
  route: "/course/[course_id]/gradebook",
  release: "rel-1",
  contact_ok: "false",
  linked_event_id: "x".repeat(32)
};

type Parsed = { event: Record<string, unknown>; segmentId: number; events: RecordedEvent[]; header: object };
function parseSent(envelope: unknown): Parsed {
  const bytes = serializeEnvelope(envelope as Parameters<typeof serializeEnvelope>[0]);
  const parsed = parseEnvelope(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
  expect(parsed.items.map((i) => i.header.type)).toEqual(["replay_event", "replay_recording"]);
  const { segmentHeader, body } = splitReplayRecording(parsed.items[1].payload);
  expect(body[0]).toBe(0x78); // zlib header
  const events = JSON.parse(inflateSync(body).toString("utf8")) as RecordedEvent[];
  return {
    event: payloadJson<Record<string, unknown>>(parsed.items[0]),
    segmentId: segmentHeader.segment_id!,
    events,
    header: parsed.header
  };
}

const noSleep = jest.fn(async (ms: number) => {
  void ms;
});

beforeEach(() => {
  transport.sent = [];
  transport.script = [];
  transport.signals = [];
  transport.maxInFlight = 0;
  noSleep.mockClear();
  resetUploadStateForTests();
  clock += 10_000_000;
});

describe("planSegments", () => {
  it("keeps one segment per checkout when each fits, numbered 0..n", async () => {
    const buf = bufferOf([
      checkout(clock, [mutation(clock + 10)]),
      checkout(clock + 60_000, [mutation(clock + 60_010)])
    ]);
    const plan = await planSegments(buf, compress);
    expect(plan.segments.map((s) => s.segmentId)).toEqual([0, 1]);
    expect(plan.segments[1].events[0].type).toBe(4);
    expect(plan.dropped).toEqual([]);
  });

  it("splits an oversized checkout at event boundaries, every piece under the cap", async () => {
    const max = 20_000;
    const events = Array.from({ length: 60 }, (_, i) => mutation(clock + 10 + i, noise(2_000)));
    const buf = bufferOf([checkout(clock, events), checkout(clock + 60_000, [mutation(clock + 60_010)])]);
    const plan = await planSegments(buf, compress, max);
    expect(plan.segments.length).toBeGreaterThan(3);
    for (const s of plan.segments) expect(s.compressed.length).toBeLessThanOrEqual(max);
    expect(plan.segments.map((s) => s.segmentId)).toEqual(plan.segments.map((_, i) => i));
    expect(plan.segments[0].events[0].type).toBe(4);
    expect(plan.segments[0].events[1].type).toBe(2);
    // Continuation pieces are incremental events; the next checkout starts fresh.
    expect(plan.segments[1].events[0].type).toBe(3);
    expect(plan.segments[plan.segments.length - 1].events[0].type).toBe(4);
    // Nothing lost or reordered.
    const flat = plan.segments.flatMap((s) => s.events);
    expect(flat).toEqual(buf.segments.flatMap((s) => s.events));
    // Each body inflates to its events.
    for (const s of plan.segments) expect(JSON.parse(inflateSync(s.compressed).toString())).toEqual(s.events);
  });

  it("never cuts between Meta and FullSnapshot when the snapshot is most of the characters but compresses well", async () => {
    // The snapshot is ~540k characters that deflate to almost nothing, so the whole checkout's
    // ratio puts the first estimated cut right after Meta.
    const max = 100_000;
    const events = Array.from({ length: 300 }, (_, i) => mutation(clock + 10 + i, noise(1_000)));
    const big: FrozenSegment = {
      ...checkout(clock, []),
      events: [meta(clock), snapshot(clock + 1, "<div class=row>masked</div>".repeat(20_000)), ...events]
    };
    const buf = bufferOf([big, checkout(clock + 60_000, [mutation(clock + 60_010)])]);
    const plan = await planSegments(buf, compress, max);
    expect(plan.segments.length).toBeGreaterThan(2);
    expect(plan.segments[0].events[0].type).toBe(4);
    expect(plan.segments[0].events[1].type).toBe(2);
    // No piece is a lone Meta, and every later piece of the first checkout is a continuation.
    for (const s of plan.segments) {
      expect(s.compressed.length).toBeLessThanOrEqual(max);
      if (s.events[0].type === 4) expect(s.events[1]?.type).toBe(2);
    }
    expect(plan.segments.filter((s) => s.events[0].type === 4)).toHaveLength(2);
    expect(plan.segments.flatMap((s) => s.events)).toEqual(buf.segments.flatMap((s) => s.events));
    expect(plan.dropped).toEqual([]);
  });

  it("never bisects between Meta and FullSnapshot", async () => {
    // A compressor that reports every piece of 3+ events as over the cap forces `fit` to bisect
    // down to its smallest pieces; the first must still hold Meta + FullSnapshot together.
    const buf = bufferOf([checkout(clock, [mutation(clock + 10), mutation(clock + 20)])]);
    const counting: Compressor = async (bytes) => {
      const n = (JSON.parse(new TextDecoder().decode(bytes)) as unknown[]).length;
      return n >= 3 ? new Uint8Array(10_000) : compress(bytes);
    };
    const plan = await planSegments(buf, counting, 5_000);
    expect(plan.segments.map((s) => s.events.map((e) => e.type))).toEqual([[4, 2], [3], [3]]);
  });

  it("drops a checkout whose FullSnapshot alone is over the cap", async () => {
    const max = 5_000;
    const big: FrozenSegment = {
      ...checkout(clock, [mutation(clock + 10)]),
      events: [meta(clock), snapshot(clock + 1, noise(20_000)), mutation(clock + 10)]
    };
    const buf = bufferOf([big, checkout(clock + 60_000, [mutation(clock + 60_010)])]);
    const plan = await planSegments(buf, compress, max);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].segmentId).toBe(0);
    expect(plan.segments[0].events[0]).toEqual(meta(clock + 60_000));
    expect(plan.dropped).toEqual([{ events: 3, from: clock, to: clock + 10, reason: "checkout" }]);
  });

  it("ends a checkout just before an oversized incremental event", async () => {
    const max = 5_000;
    const buf = bufferOf([
      checkout(clock, [mutation(clock + 10), mutation(clock + 20, noise(20_000)), mutation(clock + 30)]),
      checkout(clock + 60_000, [])
    ]);
    const plan = await planSegments(buf, compress, max);
    expect(plan.segments.flatMap((s) => s.events).map((e) => e.timestamp)).toEqual([
      clock,
      clock + 1,
      clock + 10,
      clock + 60_000,
      clock + 60_001
    ]);
    expect(plan.dropped).toEqual([{ events: 2, from: clock + 20, to: clock + 30, reason: "tail" }]);
  });
});

describe("uploadReplay", () => {
  it("sends one replay_event + replay_recording envelope per segment, in order, with the replay fields", async () => {
    (
      SentryMock as unknown as { __scope: { setUser: (u: object) => void; addBreadcrumb: (b: object) => void } }
    ).__scope.setUser({
      id: "user-1",
      email: "leak@example.com",
      username: "leaky"
    });
    (SentryMock as unknown as { __scope: { addBreadcrumb: (b: object) => void } }).__scope.addBreadcrumb({
      category: "console",
      message: "unredacted console text"
    });
    const buf = bufferOf([
      checkout(clock, [mutation(clock + 1000)]),
      checkout(clock + 60_000, [mutation(clock + 61_000)]),
      checkout(clock + 120_000, [mutation(clock + 179_000)])
    ]);
    let stats: UploadStats | undefined;
    const result = await uploadReplay(buf, tags, { sleep: noSleep, compress, onStats: (s) => (stats = s) });
    expect(result).toEqual({ ok: true, replayId: buf.replayId, segments: 3 });
    expect(transport.maxInFlight).toBe(1);
    expect(stats?.attempts).toEqual([1, 1, 1]);

    const parsed = transport.sent.map(parseSent);
    expect(parsed.map((p) => p.segmentId)).toEqual([0, 1, 2]);
    parsed.forEach((p, i) => {
      const e = p.event;
      expect(e.type).toBe("replay_event");
      expect(e.event_id).toBe(buf.replayId);
      expect(e.replay_id).toBe(buf.replayId);
      expect(e.segment_id).toBe(i);
      expect(e.replay_type).toBe("buffer");
      expect(e.replay_start_timestamp).toBe(clock / 1000);
      expect(e.timestamp).toBe(buf.segments[i].endTimestamp / 1000);
      expect(e.tags).toEqual({
        class_id: "1",
        role: "student",
        route: "/course/[course_id]/gradebook",
        release: "rel-1",
        contact_ok: "false"
      });
      expect(e.user).toEqual({ id: "user-1", ip_address: null });
      expect(e.release).toBe("rel-1");
      expect(e.environment).toBe("test");
      expect(e.platform).toBe("javascript");
      expect(e).not.toHaveProperty("breadcrumbs");
      expect(e).not.toHaveProperty("extra");
      expect(JSON.stringify(e)).not.toContain("leak@example.com");
      expect(JSON.stringify(e)).not.toContain("unredacted console text");
      expect(p.events).toEqual(buf.segments[i].events);
      expect(p.header).toMatchObject({ event_id: buf.replayId });
    });
    expect(parsed[0].event.urls).toEqual(buf.urls);
    expect(parsed[0].event.error_ids).toEqual(buf.errorIds);
    expect(parsed[0].event.trace_ids).toEqual(buf.traceIds);
    expect(parsed[1].event.urls).toEqual([]);
  });

  it("retries a 5xx with backoff, then succeeds", async () => {
    transport.script = [{ statusCode: 200 }, { statusCode: 503 }, { statusCode: 200 }];
    const buf = bufferOf([checkout(clock, []), checkout(clock + 60_000, [])]);
    let stats: UploadStats | undefined;
    const result = await uploadReplay(buf, tags, { sleep: noSleep, compress, onStats: (s) => (stats = s) });
    expect(result.ok).toBe(true);
    expect(stats?.attempts).toEqual([1, 2]);
    expect(noSleep.mock.calls).toEqual([[1000]]);
    expect(transport.sent.map((e) => parseSent(e).segmentId)).toEqual([0, 1, 1]);
  });

  it("waits out a 5xx's Retry-After before retrying, and does not treat it as a rate limit", async () => {
    transport.script = [{ statusCode: 503, headers: { "retry-after": "5" } }, { statusCode: 200 }];
    const buf = bufferOf([checkout(clock, [])]);
    expect(await uploadReplay(buf, tags, { sleep: noSleep, compress })).toMatchObject({ ok: true });
    expect(noSleep.mock.calls).toEqual([[5000]]);
    expect(transport.sent).toHaveLength(2);
  });

  it(`caps a 5xx's Retry-After at ${MAX_RETRY_AFTER_MS} ms`, async () => {
    transport.script = [{ statusCode: 503, headers: { "retry-after": "3600" } }, { statusCode: 200 }];
    expect(await uploadReplay(bufferOf([checkout(clock, [])]), tags, { sleep: noSleep, compress })).toMatchObject({
      ok: true
    });
    expect(noSleep.mock.calls).toEqual([[MAX_RETRY_AFTER_MS]]);
  });

  it("fails (not rate_limited) when every try is a 5xx with Retry-After, and the next upload still sends", async () => {
    const busy = { statusCode: 503, headers: { "retry-after": "2" } };
    transport.script = [busy, busy, busy];
    const buf = bufferOf([checkout(clock, [])]);
    expect(await uploadReplay(buf, tags, { sleep: noSleep, compress })).toEqual({
      ok: false,
      reason: "failed",
      replayId: buf.replayId
    });
    expect(transport.sent).toHaveLength(MAX_ATTEMPTS);
    expect(noSleep.mock.calls).toEqual([[2000], [2000]]);
    expect(await uploadReplay(buf, tags, { sleep: noSleep, compress })).toMatchObject({ ok: true });
    expect(transport.sent).toHaveLength(MAX_ATTEMPTS + 1);
  });

  it("retries network errors and transport drops (no status)", async () => {
    transport.script = ["throw", {}, { statusCode: 200 }];
    const result = await uploadReplay(bufferOf([checkout(clock, [])]), tags, { sleep: noSleep, compress });
    expect(result.ok).toBe(true);
    expect(noSleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it(`gives up after ${MAX_ATTEMPTS} tries`, async () => {
    transport.script = [{ statusCode: 500 }, { statusCode: 502 }, { statusCode: 504 }];
    const result = await uploadReplay(bufferOf([checkout(clock, []), checkout(clock + 60_000, [])]), tags, {
      sleep: noSleep,
      compress
    });
    expect(result).toEqual({ ok: false, reason: "failed", replayId: "a".repeat(32) });
    expect(transport.sent).toHaveLength(3);
  });

  it("treats 413 as permanent", async () => {
    transport.script = [{ statusCode: 413 }];
    const result = await uploadReplay(bufferOf([checkout(clock, [])]), tags, { sleep: noSleep, compress });
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(transport.sent).toHaveLength(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("stops at a 429 and refuses the next upload while the limit lasts", async () => {
    transport.script = [{ statusCode: 200 }, { statusCode: 429, headers: { "retry-after": "60" } }];
    const buf = bufferOf([checkout(clock, []), checkout(clock + 60_000, []), checkout(clock + 120_000, [])]);
    expect(await uploadReplay(buf, tags, { sleep: noSleep, compress })).toMatchObject({
      ok: false,
      reason: "rate_limited"
    });
    expect(transport.sent).toHaveLength(2);
    expect(await uploadReplay(buf, tags, { sleep: noSleep, compress })).toMatchObject({
      ok: false,
      reason: "rate_limited"
    });
    expect(transport.sent).toHaveLength(2);
  });

  it("fails without sending when there is nothing replayable", async () => {
    const buf = bufferOf([]);
    expect(await uploadReplay(buf, tags, { sleep: noSleep, compress })).toMatchObject({ ok: false, reason: "failed" });
    expect(transport.sent).toHaveLength(0);
  });

  it("reports dropped events so the feedback can say the replay has a gap", async () => {
    const buf = bufferOf([
      checkout(clock, [mutation(clock + 10), mutation(clock + 20, noise(20_000))]),
      checkout(clock + 60_000, [])
    ]);
    const result = await uploadReplay(buf, tags, { sleep: noSleep, compress, maxSegmentCompressedBytes: 5_000 });
    expect(result).toEqual({ ok: true, replayId: buf.replayId, segments: 2, dropped: { events: 1, ms: 0 } });
  });

  it("stops before the next segment when aborted", async () => {
    const controller = new AbortController();
    transport.script = [{ statusCode: 503 }];
    const sleep = async () => controller.abort();
    const result = await uploadReplay(bufferOf([checkout(clock, [])]), tags, {
      sleep,
      compress,
      signal: controller.signal
    });
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(transport.sent).toHaveLength(1);
  });

  it(`times out a send after ${SEND_TIMEOUT_MS} ms, aborts its fetch, and retries`, async () => {
    jest.useFakeTimers();
    try {
      transport.script = ["hang", { statusCode: 200 }];
      let stats: UploadStats | undefined;
      const pending = uploadReplay(bufferOf([checkout(clock, [])]), tags, {
        sleep: noSleep,
        compress,
        onStats: (s) => (stats = s)
      });
      await jest.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 1);
      expect(transport.sent).toHaveLength(1);
      expect(transport.signals[0]?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: true });
      expect(transport.signals[0]?.aborted).toBe(true);
      expect(stats?.attempts).toEqual([2]);
      expect(noSleep.mock.calls).toEqual([[1000]]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("times out an injected transport that ignores the signal", async () => {
    jest.useFakeTimers();
    try {
      const hanging = { send: jest.fn(() => new Promise<never>(() => {})) };
      const pending = uploadReplay(bufferOf([checkout(clock, [])]), tags, {
        sleep: noSleep,
        compress,
        transport: hanging
      });
      await jest.advanceTimersByTimeAsync(SEND_TIMEOUT_MS * MAX_ATTEMPTS);
      expect(await pending).toMatchObject({ ok: false, reason: "failed" });
      expect(hanging.send).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    } finally {
      jest.useRealTimers();
    }
  });

  it("aborts the in-flight request when the signal fires, without retrying", async () => {
    const controller = new AbortController();
    transport.script = ["hang"];
    const pending = uploadReplay(bufferOf([checkout(clock, []), checkout(clock + 60_000, [])]), tags, {
      sleep: noSleep,
      compress,
      signal: controller.signal
    });
    while (transport.sent.length === 0) await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: "failed" });
    expect(transport.signals[0]?.aborted).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("sends through a fetch transport to the tunnel with keepalive off", async () => {
    await uploadReplay(bufferOf([checkout(clock, [])]), tags, { sleep: noSleep, compress });
    expect(transportOptions).toHaveLength(1);
    expect(transportOptions[0]).toMatchObject({
      tunnel: "/api/tunnel",
      url: "/api/tunnel",
      fetchOptions: { keepalive: false }
    });
  });

  it("uses 900 KiB as the default cap", () => {
    expect(MAX_SEGMENT_COMPRESSED_BYTES).toBe(900 * 1024);
  });
});
