/**
 * Ring of rrweb checkout segments. No rrweb import: it only looks at event types, so it is
 * unit-testable without a DOM.
 *
 * Every segment starts at a Meta event (type 4), which rrweb always follows with a
 * FullSnapshot (type 2). Trimming drops whole segments from the front, so whatever is kept
 * starts with Meta + FullSnapshot and replays on its own. Events are stored as JSON strings:
 * that gives the size the cap counts, and makes `freeze()` a deep copy for free.
 */
import {
  DEFAULT_RING_BUFFER_LIMITS,
  RRWEB_EVENT_TYPE,
  type FrozenSegment,
  type RecordedEvent,
  type RingBufferLimits
} from "./types";
import type { RecordingLevel } from "./routePolicy";

type Segment = {
  events: string[];
  startTimestamp: number;
  endTimestamp: number;
  size: number;
  level: RecordingLevel;
  /** Set once this segment has asked for an early checkout, so it asks only once. */
  checkoutRequested: boolean;
};

export type PushResult = {
  /** The buffer wants a fresh checkout (`record.takeFullSnapshot(true)`) soon. */
  requestCheckout: boolean;
};

/**
 * A segment larger than this share of the cap asks for an early checkout. Keeping segments
 * well under the cap is what lets dropping whole segments hold the total under it.
 */
const EARLY_CHECKOUT_FRACTION = 4;

export class RingBuffer {
  private segments: Segment[] = [];
  private total = 0;
  private pushed = 0;
  /**
   * True after the only segment was dropped for exceeding the cap: later events belong to a
   * segment whose start is gone, so they are dropped until the next Meta.
   */
  private awaitingCheckout = false;
  readonly limits: RingBufferLimits;

  constructor(limits: Partial<RingBufferLimits> = {}) {
    this.limits = { ...DEFAULT_RING_BUFFER_LIMITS, ...limits };
  }

  /** `level` is the level the event was recorded at; a segment takes the level of its Meta. */
  push(event: RecordedEvent, level: RecordingLevel = "structure"): PushResult {
    const json = JSON.stringify(event);
    const ts = event.timestamp;
    this.pushed += json.length;
    if (event.type === RRWEB_EVENT_TYPE.Meta) {
      this.segments.push({
        events: [],
        startTimestamp: ts,
        endTimestamp: ts,
        size: 0,
        level,
        checkoutRequested: false
      });
      this.awaitingCheckout = false;
    }
    const current = this.segments[this.segments.length - 1];
    // Nothing before the first Meta, or after an oversized segment was dropped, can replay.
    if (!current || this.awaitingCheckout) return { requestCheckout: false };

    current.events.push(json);
    current.size += json.length;
    current.endTimestamp = Math.max(current.endTimestamp, ts);
    this.total += json.length;

    let requestCheckout = false;
    this.trimToSize();
    if (this.segments.length === 0) {
      // The newest segment alone was over the cap. If that happened inside its own snapshot,
      // an immediate checkout would only repeat it; wait for rrweb's regular one.
      requestCheckout = current.events.length > 2;
      this.awaitingCheckout = true;
    } else if (
      !current.checkoutRequested &&
      current.events.length > 2 &&
      current.size > this.limits.maxSize / EARLY_CHECKOUT_FRACTION
    ) {
      current.checkoutRequested = true;
      requestCheckout = true;
    }
    this.trimToAge(ts);
    return { requestCheckout };
  }

  /** Drop whole oldest segments until the total fits the cap. */
  private trimToSize(): void {
    while (this.total > this.limits.maxSize && this.segments.length > 1) this.dropOldest();
    if (this.total > this.limits.maxSize && this.segments.length === 1) this.dropOldest();
  }

  /**
   * Drop the oldest segment while the next one already starts at or before the cutoff, so the
   * kept window covers the last `maxAgeMs`. rrweb checks out on the first incremental event
   * after the interval, so a segment can run longer than `checkoutEveryMs`; the second
   * condition caps the window at `maxAgeMs + checkoutEveryMs` anyway.
   */
  private trimToAge(now: number): void {
    const cutoff = now - this.limits.maxAgeMs;
    const hardCutoff = cutoff - this.limits.checkoutEveryMs;
    while (
      this.segments.length > 1 &&
      (this.segments[1].startTimestamp <= cutoff || this.segments[0].startTimestamp < hardCutoff)
    ) {
      this.dropOldest();
    }
  }

  private dropOldest(): void {
    const dropped = this.segments.shift();
    if (dropped) this.total -= dropped.size;
  }

  /** Deep copy of the replayable segments, trimmed to the age limit as of `now`. */
  freeze(now: number = Date.now()): FrozenSegment[] {
    this.trimToAge(now);
    const out: FrozenSegment[] = [];
    for (const seg of this.segments) {
      const events = seg.events.map((e) => JSON.parse(e) as RecordedEvent);
      // A segment whose snapshot failed has a Meta and nothing to replay from.
      if (events[0]?.type !== RRWEB_EVENT_TYPE.Meta || events[1]?.type !== RRWEB_EVENT_TYPE.FullSnapshot) continue;
      out.push({
        events,
        startTimestamp: seg.startTimestamp,
        endTimestamp: seg.endTimestamp,
        size: seg.size,
        level: seg.level
      });
    }
    return out;
  }

  /** Characters of event JSON currently held. */
  get size(): number {
    return this.total;
  }

  /** Characters of event JSON ever pushed, kept or not. */
  get totalPushed(): number {
    return this.pushed;
  }

  get segmentCount(): number {
    return this.segments.length;
  }

  get eventCount(): number {
    return this.segments.reduce((n, s) => n + s.events.length, 0);
  }

  clear(): void {
    this.segments = [];
    this.total = 0;
    this.awaitingCheckout = false;
  }
}
