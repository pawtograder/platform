/**
 * @jest-environment node
 */
import {
  parseEnvelope,
  parseEnvelopeHeader,
  payloadJson,
  serializeEnvelope,
  splitReplayRecording
} from "@/lib/bugReport/envelope";
import { deflateSync, inflateSync } from "node:zlib";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("envelope framing", () => {
  it("parses a header-only envelope, with or without a trailing newline", () => {
    expect(parseEnvelope(enc.encode('{"event_id":"abc"}')).header).toEqual({ event_id: "abc" });
    expect(parseEnvelope(enc.encode('{"event_id":"abc"}\n')).items).toEqual([]);
  });

  it("parses items without length as newline-terminated", () => {
    const env = parseEnvelope(enc.encode('{"dsn":"x"}\n{"type":"event"}\n{"a":1}\n{"type":"client_report"}\n{"b":2}'));
    expect(env.items.map((i) => i.header.type)).toEqual(["event", "client_report"]);
    expect(payloadJson(env.items[0])).toEqual({ a: 1 });
    expect(payloadJson(env.items[1])).toEqual({ b: 2 });
  });

  it("uses length for binary payloads containing newlines and invalid UTF-8", () => {
    const binary = new Uint8Array([0x0a, 0xff, 0xfe, 0x00, 0x0a, 0x80, 0xc3]);
    const bytes = serializeEnvelope({ event_id: "e1" }, [
      { header: { type: "attachment" }, payload: binary },
      { header: { type: "event" }, payload: '{"x":"y"}' }
    ]);
    const env = parseEnvelope(bytes);
    expect(env.items).toHaveLength(2);
    expect(Array.from(env.items[0].payload)).toEqual(Array.from(binary));
    expect(env.items[0].header.length).toBe(binary.length);
    expect(payloadJson(env.items[1])).toEqual({ x: "y" });
  });

  it("accepts an empty payload with length 0", () => {
    const env = parseEnvelope(enc.encode('{}\n{"type":"attachment","length":0}\n\n{"type":"event","length":2}\n{}'));
    expect(env.items[0].payload.length).toBe(0);
    expect(payloadJson(env.items[1])).toEqual({});
  });

  it("rejects malformed framing", () => {
    expect(() => parseEnvelope(enc.encode("not json\n"))).toThrow(/envelope header/);
    expect(() => parseEnvelope(enc.encode('{}\n{"no_type":1}\n{}'))).toThrow(/missing type/);
    expect(() => parseEnvelope(enc.encode('{}\n{"type":"x","length":99}\nshort'))).toThrow(/length/);
    expect(() => parseEnvelopeHeader(enc.encode("[1,2]\n"))).toThrow(/not a JSON object/);
  });

  it("parses only the header line", () => {
    const bytes = new Uint8Array([...enc.encode('{"dsn":"https://k@h/1"}\n'), 0xff, 0xfe]);
    expect(parseEnvelopeHeader(bytes)).toEqual({ dsn: "https://k@h/1" });
  });

  it("splits a replay_recording payload into its segment header and compressed body", () => {
    const events = [{ type: 4, data: {} }];
    const compressed = deflateSync(Buffer.from(JSON.stringify(events)));
    const payload = new Uint8Array([...enc.encode('{"segment_id":3}\n'), ...compressed]);
    const bytes = serializeEnvelope({ event_id: "r" }, [
      { header: { type: "replay_event" }, payload: "{}" },
      { header: { type: "replay_recording" }, payload }
    ]);
    const recording = parseEnvelope(bytes).items[1];
    const { segmentHeader, body } = splitReplayRecording(recording.payload);
    expect(segmentHeader).toEqual({ segment_id: 3 });
    expect(JSON.parse(dec.decode(inflateSync(body)))).toEqual(events);
  });
});
