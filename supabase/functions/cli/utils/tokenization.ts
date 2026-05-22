/**
 * Tokenization for assessment export.
 *
 * Three identity modes drive how raw database ids appear in the exported NDJSON:
 *
 *   - "raw"    — emit the real id (string or number). No tokenizer is used.
 *   - "hash"   — HMAC of the id using a CLI-supplied salt combined with a
 *                server-side vault pepper. Same salt on the same deployment =>
 *                same tokens (joinable across dumps). Offline recompute requires
 *                the pepper, which never leaves the server.
 *   - "opaque" — same HMAC scheme with a CLI-generated random per-run salt.
 *                Tokens are stable within one run but not reproducible without
 *                both the ephemeral salt and the server pepper.
 *
 * Key derivation (server-only):
 *   derivedKey = HMAC-SHA256(pepper, clientSalt)
 *   token      = base32(HMAC-SHA256(derivedKey, `${kind}:${rawId}`))[0:16]
 *
 * Kind-namespacing prevents two different objects with the same numeric id
 * (e.g. submission #123 and student-profile #123) from colliding.
 */

export type IdentityMode = "raw" | "hash" | "opaque";

/** Logical category of the id being tokenized. New kinds can be added freely. */
export type TokenKind =
  | "subject"
  | "group"
  | "submission"
  | "section_class"
  | "section_lab"
  | "gradebook_column"
  | "rubric_check"
  | "grader_test"
  | "hint";

export interface Tokenizer {
  /** Returns the token for (kind, rawId). Stable for the lifetime of the tokenizer. */
  token(kind: TokenKind, rawId: string | number | bigint): Promise<string>;
}

/**
 * Build a tokenizer bound to a client salt and server pepper. The salt MUST be
 * at least 16 characters; the pepper MUST be at least 32. Only the edge
 * function calls this — the CLI never receives the pepper.
 *
 * Tokens are computed lazily and cached so repeated lookups for the same
 * (kind, id) are O(1) after the first call.
 */
export async function createTokenizer(salt: string, pepper: string): Promise<Tokenizer> {
  if (salt.length < 16) {
    throw new Error("tokenizer salt must be at least 16 characters");
  }
  if (pepper.length < 32) {
    throw new Error("tokenizer pepper must be at least 32 characters");
  }

  const encoder = new TextEncoder();

  const pepperKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const derivedKeyBytes = await crypto.subtle.sign("HMAC", pepperKey, encoder.encode(salt));

  const key = await crypto.subtle.importKey(
    "raw",
    derivedKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const cache = new Map<string, string>();

  async function compute(kind: TokenKind, rawId: string | number | bigint): Promise<string> {
    const message = `${kind}:${String(rawId)}`;
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    return base32(new Uint8Array(signature)).slice(0, 16);
  }

  return {
    async token(kind, rawId) {
      const cacheKey = `${kind}:${String(rawId)}`;
      const hit = cache.get(cacheKey);
      if (hit !== undefined) return hit;
      const value = await compute(kind, rawId);
      cache.set(cacheKey, value);
      return value;
    }
  };
}

/**
 * RFC 4648 base32 (no padding, lowercase). Chosen over hex because tokens
 * appear in many output rows and shorter strings make NDJSON streams smaller;
 * chosen over base64 because base32 is filename- and URL-safe without
 * substitution.
 */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Generate a cryptographically random salt suitable for opaque mode.
 * 32 bytes of entropy, base32-encoded => 52-char string.
 */
export function generateRandomSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base32(bytes);
}
