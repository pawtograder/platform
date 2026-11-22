import { Buffer } from "node:buffer";

/** Base64 with at least one data character, optional trailing padding, nothing else. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes base64, returning null when the input was not valid base64.
 *
 * `Buffer.from(x, "base64")` never throws — it drops characters outside the
 * alphabet — so the only way to know the input decoded losslessly is to re-encode
 * and compare. Without this a corrupt manifest uploaded truncated artifact bytes
 * and reported success.
 */
export function decodeBase64Strict(input: string): Uint8Array | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const normalized = input.replace(/\s+/g, "");

  // The grammar is checked before decoding. Padding-only input ("=", "====", or
  // whitespace around one) slipped through the re-encode comparison below, because
  // Buffer decodes it to zero bytes and stripping padding reduces both operands to the
  // empty string — so `--overwrite` replaced a real artifact with an empty object and
  // reported success. Requiring a data character also rules out the empty payload,
  // which the length guard above already rejected in its unpadded form.
  if (!BASE64_RE.test(normalized)) return null;
  // 4n+1 is not a reachable length for base64; the re-encode check catches it too, but
  // failing here says why.
  if (normalized.replace(/=+$/, "").length % 4 === 1) return null;

  const buf = Buffer.from(normalized, "base64");
  if (buf.length === 0) return null;
  // Re-encoding is canonical, so compare against the canonicalized input: strip
  // padding from both sides rather than requiring the caller to pad exactly.
  const reencoded = buf.toString("base64").replace(/=+$/, "");
  if (reencoded !== normalized.replace(/=+$/, "")) return null;
  return new Uint8Array(buf);
}
