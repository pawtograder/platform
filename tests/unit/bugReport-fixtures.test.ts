/**
 * @jest-environment node
 *
 * The pure parts of the bug-reporter E2E fixtures (tests/e2e/bugReport/): envelope capture
 * parsing, the replay-upload detector, and the canary scan.
 */
import { deflateSync } from "node:zlib";
import { serializeEnvelope } from "@/lib/bugReport/envelope";
import {
  assertNoReplayUploaded,
  parseCapturedEnvelope,
  rrwebMarkerIn,
  type TunnelCapture
} from "../e2e/bugReport/tunnel";
import { scanForCanaries, type CanaryRegistry } from "../e2e/bugReport/canaries";

const enc = new TextEncoder();
const rrwebEvents = [
  { type: 4, data: { href: "http://localhost:3001/course/1", width: 1280, height: 720 }, timestamp: 1 },
  { type: 2, data: { node: { type: 0, childNodes: [], id: 1 }, initialOffset: { left: 0, top: 0 } }, timestamp: 2 }
];

function replayEnvelope(compressed: boolean) {
  const events = Buffer.from(JSON.stringify(rrwebEvents));
  const body = compressed ? deflateSync(events) : events;
  return serializeEnvelope({ event_id: "a".repeat(32) }, [
    { header: { type: "replay_event" }, payload: JSON.stringify({ replay_id: "a".repeat(32), segment_id: 0 }) },
    { header: { type: "replay_recording" }, payload: new Uint8Array([...enc.encode('{"segment_id":0}\n'), ...body]) }
  ]);
}

function captureOf(bodies: Uint8Array[], otherRequests: Uint8Array[] = []): TunnelCapture {
  const envelopes = bodies.map((b) => parseCapturedEnvelope(b));
  return {
    envelopes,
    requests: otherRequests.map((body) => ({ method: "POST", url: "http://localhost/x", resourceType: "fetch", body })),
    items: () => [],
    uploadedBytes: () => [],
    waitForEnvelope: () => Promise.reject(new Error("unused")),
    stop: async () => {}
  };
}

describe("parseCapturedEnvelope", () => {
  it.each([true, false])("inflates replay_recording bodies (compressed: %s)", (compressed) => {
    const captured = parseCapturedEnvelope(replayEnvelope(compressed));
    const recording = captured.items.find((i) => i.header.type === "replay_recording")!;
    expect(recording.segmentHeader).toEqual({ segment_id: 0 });
    expect(recording.recordingEvents).toEqual(rrwebEvents);
  });

  it("keeps unparseable bodies with the error", () => {
    const captured = parseCapturedEnvelope(enc.encode("not an envelope"));
    expect(captured.parseError).toMatch(/envelope header/);
    expect(captured.items).toEqual([]);
  });
});

describe("assertNoReplayUploaded", () => {
  const errorEnvelope = serializeEnvelope({ event_id: "b".repeat(32) }, [
    {
      header: { type: "event" },
      payload: JSON.stringify({ exception: {}, contexts: { trace: { replay_id: "c".repeat(32) } } })
    }
  ]);

  it("passes for error events, even ones carrying a replay_id", () => {
    expect(() => assertNoReplayUploaded(captureOf([errorEnvelope]))).not.toThrow();
  });

  it("fails on replay items in a tunnel envelope", () => {
    expect(() => assertNoReplayUploaded(captureOf([replayEnvelope(true)]))).toThrow(/replay_event item/);
  });

  it("fails on rrweb events in any other request body, compressed or not", () => {
    const raw = enc.encode(JSON.stringify(rrwebEvents));
    expect(() => assertNoReplayUploaded(captureOf([], [raw]))).toThrow(/Replay data was uploaded/);
    expect(() => assertNoReplayUploaded(captureOf([], [new Uint8Array(deflateSync(raw))]))).toThrow(
      /Replay data was uploaded/
    );
  });

  it("finds a compressed recording after a JSON line", () => {
    const body = new Uint8Array([...enc.encode('{"x":1}\n'), ...deflateSync(JSON.stringify(rrwebEvents))]);
    expect(rrwebMarkerIn(body)).not.toBeNull();
    expect(rrwebMarkerIn(enc.encode('{"type":2,"message":"ordinary json"}'))).toBeNull();
  });
});

describe("scanForCanaries", () => {
  const registry: CanaryRegistry = new Map([
    ["Quillon Vantrees", { kind: "name", column: "profiles.name", rowId: "p1" }],
    ["qv-canary-7781@example.edu", { kind: "email", column: "users.email", rowId: "u1" }],
    ["87.31", { kind: "grade", column: "gradebook_column_students.score", rowId: 9 }]
  ]);

  it("returns [] when nothing leaks", () => {
    expect(scanForCanaries([enc.encode("nothing to see"), "still nothing"], registry)).toEqual([]);
  });

  it("finds canaries and their variants across sources", () => {
    const hits = scanForCanaries(
      [enc.encode('{"text":"VANTREES, quillon"}'), "mail qv-canary-7781@example.edu", "score 87.31"],
      registry
    );
    expect(hits.map((h) => [h.source, h.canary, h.matched])).toEqual(
      expect.arrayContaining([
        [0, "Quillon Vantrees", "Vantrees, Quillon"],
        [1, "qv-canary-7781@example.edu", "qv-canary-7781@example.edu"],
        [2, "87.31", "87.31"]
      ])
    );
    expect(hits.find((h) => h.canary === "87.31")!.entry).toEqual({
      kind: "grade",
      column: "gradebook_column_students.score",
      rowId: 9
    });
  });
});
