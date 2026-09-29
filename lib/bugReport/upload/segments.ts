/**
 * Cuts a frozen (already redacted) buffer into replay upload segments that each fit under the
 * compressed size cap. No Sentry import: it only looks at rrweb event types, so it is
 * unit-testable with any compressor.
 *
 * One upload segment per checkout segment of the ring buffer, so each starts with Meta +
 * FullSnapshot, except where a checkout is too big for the cap: then it is split at event
 * boundaries. The first piece keeps the checkout's Meta + FullSnapshot and the later pieces are
 * plain continuations (incremental events against the same node ids). Sentry's player
 * concatenates the segments in `segment_id` order, so that replays the same as one segment.
 */
import { RRWEB_EVENT_TYPE, type FrozenBuffer, type RecordedEvent } from "../types";

/**
 * Largest compressed recording (the zlib bytes after the `{"segment_id":n}` line) one
 * segment may have.
 *
 * The spec allows 8 MiB, and relay accepts up to 10 MiB per item. But the dev Sentry answers
 * 200 for segments over about 1 MiB compressed and then silently drops them, most likely
 * Kafka's default 1 MB message limit between relay and the replay consumer (see
 * /home/jon/bug-reporter-supervisor/research/REPORT.md, "UPDATE"). 900 KiB stays under that
 * with room for the replay_event and the segment header. Human note: raising the Kafka
 * message limits on the dev and prod Sentry is what would allow bigger segments; until then
 * keep this below 1 MiB.
 */
export const MAX_SEGMENT_COMPRESSED_BYTES = 900 * 1024;

/** Compresses bytes to a zlib stream (RFC 1950), what Sentry expects after the header line. */
export type Compressor = (bytes: Uint8Array) => Promise<Uint8Array>;

export type PreparedSegment = {
  segmentId: number;
  events: RecordedEvent[];
  /** zlib-compressed JSON array of `events`. */
  compressed: Uint8Array;
  /** Timestamp (ms) of the first and last event. */
  startTimestamp: number;
  endTimestamp: number;
};

/** Events left out because a single event was bigger than the cap on its own. */
export type DroppedRange = {
  events: number;
  /** Timestamps (ms) of the first and last dropped event. */
  from: number;
  to: number;
  /** "checkout": its Meta or FullSnapshot was the oversized event, so the whole checkout went. */
  reason: "checkout" | "tail";
};

export type SegmentPlan = { segments: PreparedSegment[]; dropped: DroppedRange[] };

const encoder = new TextEncoder();

/**
 * Split pieces aim this far under the cap, so that the estimate (compression ratio of the
 * whole checkout) is usually right the first time and bisecting is rare.
 */
const SPLIT_TARGET_FRACTION = 0.85;

/** Meta + FullSnapshot: the events that open a checkout and must stay in one piece. */
const CHECKOUT_HEAD = 2;

type Piece = { events: RecordedEvent[]; compressed: Uint8Array };

function jsonArray(json: string[]): Uint8Array {
  return encoder.encode(`[${json.join(",")}]`);
}

class OversizedEvent {
  constructor(readonly index: number) {}
}

/**
 * Fits `json[from, to)` into pieces under `max`, in order. Throws OversizedEvent (with the
 * absolute index) at the first single event that can't fit, after pushing every piece before
 * it, so the caller keeps an exact prefix.
 */
async function fit(
  events: RecordedEvent[],
  json: string[],
  from: number,
  to: number,
  max: number,
  compress: Compressor,
  out: Piece[]
): Promise<void> {
  const compressed = await compress(jsonArray(json.slice(from, to)));
  if (compressed.length <= max) {
    out.push({ events: events.slice(from, to), compressed });
    return;
  }
  // The checkout's Meta + FullSnapshot (indexes 0 and 1) are never split; if the pair alone is
  // over the cap, the whole checkout is dropped.
  const firstMid = from === 0 ? CHECKOUT_HEAD : from + 1;
  if (to <= firstMid) throw new OversizedEvent(from);
  // Bisect by characters, not by count: one FullSnapshot can outweigh thousands of mouse moves.
  let total = 0;
  for (let i = from; i < to; i++) total += json[i].length;
  let acc = 0;
  for (let i = from; i < firstMid; i++) acc += json[i].length;
  let mid = firstMid;
  for (; mid < to - 1 && acc + json[mid].length <= total / 2; mid++) acc += json[mid].length;
  await fit(events, json, from, mid, max, compress, out);
  await fit(events, json, mid, to, max, compress, out);
}

/**
 * Pieces for one checkout segment, plus what was dropped from it. On an oversized event the
 * checkout ends just before it: everything kept is an exact prefix, and the next checkout's
 * Meta + FullSnapshot picks the replay back up. Truncating the event's payload instead would
 * leave the rrweb node mirror inconsistent (a half-serialized node tree) for every later event.
 */
async function packCheckout(
  events: RecordedEvent[],
  max: number,
  compress: Compressor
): Promise<{ pieces: Piece[]; dropped?: DroppedRange }> {
  const json = events.map((e) => JSON.stringify(e));
  const whole = await compress(jsonArray(json));
  if (whole.length <= max) return { pieces: [{ events, compressed: whole }] };

  // Estimate how many characters fit under the cap from the whole checkout's ratio, and cut
  // there first; `fit` bisects any piece the estimate got wrong.
  const chars = json.reduce((n, j) => n + j.length + 1, 1);
  const targetChars = Math.max(1, Math.floor(((max * SPLIT_TARGET_FRACTION) / whole.length) * chars));
  const bounds: number[] = [0];
  let acc = 0;
  for (let i = 0; i < json.length; i++) {
    // A snapshot that compresses far better than the rest can make targetChars smaller than
    // Meta + FullSnapshot; the first cut still comes after them.
    if (i >= CHECKOUT_HEAD && acc > 0 && acc + json[i].length > targetChars) {
      bounds.push(i);
      acc = 0;
    }
    acc += json[i].length + 1;
  }
  bounds.push(json.length);

  const pieces: Piece[] = [];
  try {
    for (let b = 0; b + 1 < bounds.length; b++) {
      await fit(events, json, bounds[b], bounds[b + 1], max, compress, pieces);
    }
    return { pieces };
  } catch (e) {
    if (!(e instanceof OversizedEvent)) throw e;
    const startsCheckout = e.index <= 1;
    const firstDropped = startsCheckout ? 0 : e.index;
    const dropped: DroppedRange = {
      events: events.length - firstDropped,
      from: events[firstDropped].timestamp,
      to: events[events.length - 1].timestamp,
      reason: startsCheckout ? "checkout" : "tail"
    };
    return { pieces: startsCheckout ? [] : pieces, dropped };
  }
}

function isCheckoutStart(events: RecordedEvent[]): boolean {
  return events[0]?.type === RRWEB_EVENT_TYPE.Meta && events[1]?.type === RRWEB_EVENT_TYPE.FullSnapshot;
}

/**
 * Plans the upload: segment ids 0..n with no gaps, each compressed body ≤ `maxCompressedBytes`,
 * segment 0 starting with Meta + FullSnapshot. Checkout segments that don't start with a
 * checkout (the ring buffer never produces one) are skipped, since nothing in them can replay.
 */
export async function planSegments(
  buffer: Pick<FrozenBuffer, "segments">,
  compress: Compressor,
  maxCompressedBytes: number = MAX_SEGMENT_COMPRESSED_BYTES
): Promise<SegmentPlan> {
  const segments: PreparedSegment[] = [];
  const dropped: DroppedRange[] = [];
  for (const checkout of buffer.segments) {
    if (!isCheckoutStart(checkout.events)) continue;
    const { pieces, dropped: d } = await packCheckout(checkout.events, maxCompressedBytes, compress);
    if (d) dropped.push(d);
    for (const piece of pieces) {
      segments.push({
        segmentId: segments.length,
        events: piece.events,
        compressed: piece.compressed,
        startTimestamp: piece.events[0].timestamp,
        endTimestamp: piece.events.reduce((m, e) => Math.max(m, e.timestamp), piece.events[0].timestamp)
      });
    }
  }
  return { segments, dropped };
}

/** `{"segment_id":n}\n` followed by the compressed events: the replay_recording payload. */
export function recordingPayload(segment: Pick<PreparedSegment, "segmentId" | "compressed">): Uint8Array {
  const header = encoder.encode(`${JSON.stringify({ segment_id: segment.segmentId })}\n`);
  const out = new Uint8Array(header.length + segment.compressed.length);
  out.set(header, 0);
  out.set(segment.compressed, header.length);
  return out;
}

/**
 * zlib deflate with the browser's CompressionStream. Its "deflate" format is the zlib wrapper
 * (RFC 1950: 0x78 header, Adler-32 trailer), not raw deflate ("deflate-raw"); that is what
 * Sentry inflates, and what the SDK's own replay worker produces.
 */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
