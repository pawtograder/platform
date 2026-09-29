import { RingBuffer } from "@/lib/bugReport/ringBuffer";
import type { RecordedEvent } from "@/lib/bugReport/types";

const meta = (timestamp: number) =>
  ({ type: 4, timestamp, data: { href: "http://x/", width: 1, height: 1 } }) as unknown as RecordedEvent;
const full = (timestamp: number, pad = 0) =>
  ({
    type: 2,
    timestamp,
    data: { node: { pad: "x".repeat(pad) }, initialOffset: { top: 0, left: 0 } }
  }) as unknown as RecordedEvent;
const inc = (timestamp: number, pad = 0) =>
  ({
    type: 3,
    timestamp,
    data: { source: 0, texts: [], attributes: [], removes: [], adds: [], pad: "y".repeat(pad) }
  }) as unknown as RecordedEvent;

function checkout(buf: RingBuffer, t: number, pad = 0) {
  buf.push(meta(t));
  return buf.push(full(t, pad));
}

describe("RingBuffer", () => {
  it("drops events before the first Meta", () => {
    const buf = new RingBuffer();
    buf.push(inc(1));
    expect(buf.eventCount).toBe(0);
    checkout(buf, 2);
    buf.push(inc(3));
    expect(buf.eventCount).toBe(3);
  });

  it("keeps about the last 10 minutes as whole segments starting with Meta + FullSnapshot", () => {
    const buf = new RingBuffer({ maxAgeMs: 10 * 60_000 });
    // 15 minutes, a checkout every minute, an incremental event every 10 s.
    for (let t = 0; t <= 15 * 60_000; t += 10_000) {
      if (t % 60_000 === 0) checkout(buf, t);
      else buf.push(inc(t));
    }
    const now = 15 * 60_000;
    const segments = buf.freeze(now);
    expect(segments[0].events[0].type).toBe(4);
    expect(segments[0].events[1].type).toBe(2);
    const window = now - segments[0].startTimestamp;
    expect(window).toBeGreaterThanOrEqual(10 * 60_000);
    expect(window).toBeLessThanOrEqual(10 * 60_000 + 60_000);
  });

  it("keeps the newest segment even when it is older than the window", () => {
    const buf = new RingBuffer({ maxAgeMs: 60_000 });
    checkout(buf, 0);
    expect(buf.freeze(60 * 60_000)).toHaveLength(1);
  });

  it("stays under the size cap by dropping whole old segments", () => {
    const buf = new RingBuffer({ maxSize: 10_000 });
    for (let i = 0; i < 20; i++) {
      checkout(buf, i * 1000, 1000);
      buf.push(inc(i * 1000 + 1, 500));
    }
    expect(buf.size).toBeLessThanOrEqual(10_000);
    const segments = buf.freeze(20_000);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0].events[0].type).toBe(4);
    expect(segments.reduce((n, s) => n + s.size, 0)).toBe(buf.size);
  });

  it("asks for an early checkout once a segment passes a quarter of the cap", () => {
    const buf = new RingBuffer({ maxSize: 10_000 });
    expect(checkout(buf, 0, 100).requestCheckout).toBe(false);
    expect(buf.push(inc(1, 1000)).requestCheckout).toBe(false);
    expect(buf.push(inc(2, 2000)).requestCheckout).toBe(true);
    // Only once per segment.
    expect(buf.push(inc(3, 10)).requestCheckout).toBe(false);
  });

  it("drops a lone segment that outgrows the cap and waits for the next checkout", () => {
    const buf = new RingBuffer({ maxSize: 5_000 });
    checkout(buf, 0, 100);
    buf.push(inc(1, 1000));
    expect(buf.push(inc(2, 6000)).requestCheckout).toBe(true);
    expect(buf.size).toBe(0);
    buf.push(inc(3, 10));
    expect(buf.eventCount).toBe(0);
    checkout(buf, 4);
    expect(buf.eventCount).toBe(2);
  });

  it("does not ask for a checkout when the snapshot alone is over the cap", () => {
    const buf = new RingBuffer({ maxSize: 1_000 });
    expect(checkout(buf, 0, 5_000).requestCheckout).toBe(false);
    expect(buf.size).toBe(0);
  });

  it("freeze returns a deep copy", () => {
    const buf = new RingBuffer();
    checkout(buf, 0);
    const a = buf.freeze(0);
    (a[0].events[0] as unknown as { timestamp: number }).timestamp = 99;
    expect(buf.freeze(0)[0].events[0].timestamp).toBe(0);
  });
});
