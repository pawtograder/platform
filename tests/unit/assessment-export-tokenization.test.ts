/**
 * @jest-environment node
 */

/**
 * Tokenizer correctness for assessment export.
 *
 * The tokenizer's contract is that two parallel per-assignment edge function
 * calls in one CLI run, given the same salt, must produce the same token for
 * the same (kind, raw_id) — otherwise rows from different assignments cannot
 * be joined on the analyst side. These tests pin that contract.
 */

import { createTokenizer, generateRandomSalt, base32 } from "../../supabase/functions/cli/utils/tokenization";

describe("assessment export tokenization", () => {
  const SALT = "test-salt-at-least-16-chars-long-aaaa";

  it("returns the same token for the same (kind, id) within one tokenizer", async () => {
    const t = await createTokenizer(SALT);
    const a = await t.token("subject", "user-uuid-1");
    const b = await t.token("subject", "user-uuid-1");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("returns the same token across two tokenizers built from the same salt", async () => {
    // Models the parallel-per-assignment case: each call constructs its own
    // tokenizer in the edge function, but the CLI passes the same salt to all
    // calls in a single run. Tokens must agree across calls.
    const t1 = await createTokenizer(SALT);
    const t2 = await createTokenizer(SALT);
    const a = await t1.token("submission", 1234);
    const b = await t2.token("submission", 1234);
    expect(a).toBe(b);
  });

  it("returns different tokens across runs when the salt changes (opaque mode)", async () => {
    const s1 = generateRandomSalt();
    const s2 = generateRandomSalt();
    expect(s1).not.toBe(s2);
    const t1 = await createTokenizer(s1);
    const t2 = await createTokenizer(s2);
    const a = await t1.token("subject", "user-uuid-1");
    const b = await t2.token("subject", "user-uuid-1");
    expect(a).not.toBe(b);
  });

  it("kind-namespacing prevents collisions for same numeric id across kinds", async () => {
    // Submission #1 and gradebook column #1 must not produce the same token,
    // otherwise an analyst joining tables on token would see false matches.
    const t = await createTokenizer(SALT);
    const submission = await t.token("submission", 1);
    const column = await t.token("gradebook_column", 1);
    const subject = await t.token("subject", 1);
    expect(submission).not.toBe(column);
    expect(submission).not.toBe(subject);
    expect(column).not.toBe(subject);
  });

  it("treats numeric and string ids consistently after coercion", async () => {
    // The DB sometimes hands us numbers, sometimes UUIDs. The contract is
    // "stringified id is what's hashed" so 123 and "123" produce the same
    // token — callers should never mix string-uuid ids with numeric ids
    // for the same kind anyway, so this is just documenting behavior.
    const t = await createTokenizer(SALT);
    expect(await t.token("subject", 123)).toBe(await t.token("subject", "123"));
  });

  it("rejects salts shorter than 16 chars", async () => {
    await expect(createTokenizer("short")).rejects.toThrow(/at least 16 characters/);
  });

  it("generates random salts of expected length", () => {
    // 32 bytes → 256 bits → ceil(256/5) = 52 base32 chars.
    const salt = generateRandomSalt();
    expect(salt).toHaveLength(52);
    expect(salt).toMatch(/^[a-z2-7]+$/);
  });

  it("base32 encodes a known vector correctly", () => {
    // RFC 4648 test vector: "foobar" → "mzxw6ytboi" (lowercase, no padding).
    const bytes = new TextEncoder().encode("foobar");
    expect(base32(bytes)).toBe("mzxw6ytboi");
  });
});
