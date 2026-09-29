/**
 * Unit tests for the replay upload (package 6): segment planning under the size cap, the
 * replay_event and envelope shape, sequential sending, and retries on an injected clock.
 */
import { deflateSync, inflateSync } from "node:zlib";
import type { FrozenBuffer, FrozenSegment, RecordedEvent } from "@/lib/bugReport/types";

type Response = { statusCode?: number; headers?: Record<string, string | null> };
type Step = Response | "throw";

class FakeTransport {
  sent: unknown[] = [];
  script: Step[] = [];
  inFlight = 0;
  maxInFlight = 0;
  async send(envelope: unknown): Promise<Response> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Promise.resolve();
      this.sent.push(envelope);
      const step = this.script.shift() ?? { statusCode: 200 };
      if (step === "throw") throw new TypeError("Failed to fetch");
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
const client = {
  getOptions: () => ({ release: "rel-1", environment: "test", tunnel: "/api/tunnel", integrations: [] }),
  getDsn: () => ({ protocol: "https", publicKey: "pk", host: "sentry.test", port: "", path: "", projectId: "7" }),
  getTransport: () => transport,
  getSdkMetadata: () => ({ sdk: { name: "sentry.javascript.nextjs", version: "10.3.0" } }),
  getEventProcessors: () => [],
  emit: () => {},
  on: () => () => {}
};

jest.mock("@sentry/nextjs", () => {
  const core = jest.requireActual("@sentry/core");
  const scope = new core.Scope();
  const isolation = new core.Scope();
  return {
    getClient: () => client,
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

  it("uses 900 KiB as the default cap", () => {
    expect(MAX_SEGMENT_COMPRESSED_BYTES).toBe(900 * 1024);
  });
});
