/**
 * Byte-level Sentry envelope framing (develop.sentry.dev/sdk/data-model/envelopes).
 *
 * An envelope is a JSON header line, then items. Each item is a JSON header line and a payload.
 * When the item header has `length`, the payload is exactly that many bytes and may contain
 * newlines or arbitrary binary (a `replay_recording` payload is a JSON line followed by zlib
 * bytes). Without `length`, the payload runs to the next newline or the end of the envelope.
 *
 * Everything works on bytes, never on decoded strings: decoding binary as UTF-8 replaces invalid
 * sequences with U+FFFD and changes the payload, which is the bug the tunnel had.
 */

export type EnvelopeHeader = Record<string, unknown> & { dsn?: string; event_id?: string };
export type EnvelopeItemHeader = Record<string, unknown> & { type: string; length?: number };
export type EnvelopeItem = { header: EnvelopeItemHeader; payload: Uint8Array };
export type ParsedEnvelope = { header: EnvelopeHeader; items: EnvelopeItem[] };

const NEWLINE = 0x0a;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Index of the first `\n` at or after `from`, or -1. */
function indexOfNewline(bytes: Uint8Array, from: number): number {
  return bytes.indexOf(NEWLINE, from);
}

function parseJsonLine(bytes: Uint8Array, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (e) {
    throw new Error(`Invalid ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${what}: not a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Parses only the envelope header: the bytes up to the first `\n` (or all of them if there is
 * none). Throws if that isn't a JSON object.
 */
export function parseEnvelopeHeader(bytes: Uint8Array): EnvelopeHeader {
  const end = indexOfNewline(bytes, 0);
  return parseJsonLine(end === -1 ? bytes : bytes.subarray(0, end), "envelope header") as EnvelopeHeader;
}

/** Parses a whole envelope. Throws on malformed framing. Payloads are views into `bytes`. */
export function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  let end = indexOfNewline(bytes, 0);
  const header = parseJsonLine(end === -1 ? bytes : bytes.subarray(0, end), "envelope header") as EnvelopeHeader;
  const items: EnvelopeItem[] = [];
  let pos = end === -1 ? bytes.length : end + 1;

  while (pos < bytes.length) {
    // Tolerate blank lines between items and a trailing newline.
    if (bytes[pos] === NEWLINE) {
      pos++;
      continue;
    }
    end = indexOfNewline(bytes, pos);
    const headerEnd = end === -1 ? bytes.length : end;
    const itemHeader = parseJsonLine(bytes.subarray(pos, headerEnd), "item header");
    if (typeof itemHeader.type !== "string") {
      throw new Error("Invalid item header: missing type");
    }
    pos = end === -1 ? bytes.length : end + 1;

    let payload: Uint8Array;
    const length = itemHeader.length;
    if (typeof length === "number") {
      if (!Number.isInteger(length) || length < 0 || pos + length > bytes.length) {
        throw new Error(`Invalid item length ${length} at byte ${pos}`);
      }
      payload = bytes.subarray(pos, pos + length);
      pos += length;
      if (bytes[pos] === NEWLINE) pos++;
    } else {
      end = indexOfNewline(bytes, pos);
      const payloadEnd = end === -1 ? bytes.length : end;
      payload = bytes.subarray(pos, payloadEnd);
      pos = end === -1 ? bytes.length : end + 1;
    }
    items.push({ header: itemHeader as EnvelopeItemHeader, payload });
  }
  return { header, items };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Serializes an envelope. Each item header gets `length` set to its payload's byte length, so
 * binary payloads survive a round trip through `parseEnvelope`.
 */
export function serializeEnvelope(
  header: EnvelopeHeader,
  items: { header: Omit<EnvelopeItemHeader, "length">; payload: Uint8Array | string }[]
): Uint8Array {
  const chunks: Uint8Array[] = [encoder.encode(JSON.stringify(header))];
  for (const item of items) {
    const payload = typeof item.payload === "string" ? encoder.encode(item.payload) : item.payload;
    chunks.push(encoder.encode(`\n${JSON.stringify({ ...item.header, length: payload.length })}\n`));
    chunks.push(payload);
  }
  return concat(chunks);
}

/** Decodes a JSON payload. */
export function payloadJson<T = unknown>(item: EnvelopeItem): T {
  return JSON.parse(decoder.decode(item.payload)) as T;
}

/**
 * Splits a `replay_recording` payload into its `{"segment_id":n}` header line and the bytes after
 * it (zlib-compressed rrweb events, or plain JSON for uncompressed recordings).
 */
export function splitReplayRecording(payload: Uint8Array): {
  segmentHeader: { segment_id?: number };
  body: Uint8Array;
} {
  const end = indexOfNewline(payload, 0);
  if (end === -1) throw new Error("replay_recording payload has no header line");
  return {
    segmentHeader: parseJsonLine(payload.subarray(0, end), "replay_recording header") as { segment_id?: number },
    body: payload.subarray(end + 1)
  };
}
