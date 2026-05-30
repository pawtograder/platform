/**
 * @jest-environment node
 */

/**
 * Tokenizer correctness for assessment export.
 *
 * Tokens use HMAC(clientSalt, id) after key derivation from a server pepper.
 * Two parallel per-assignment edge calls with the same salt and pepper must
 * produce identical tokens for the same (kind, raw_id).
 */

import { createTokenizer, generateRandomSalt, base32 } from "../../supabase/functions/cli/utils/tokenization";

describe("assessment export tokenization", () => {
  const SALT = "test-salt-at-least-16-chars-long-aaaa";
  const PEPPER = "test-pepper-at-least-32-characters-long-for-export";

  it("returns the same token for the same (kind, id) within one tokenizer", async () => {
    const t = await createTokenizer(SALT, PEPPER);
    const a = await t.token("subject", "user-uuid-1");
    const b = await t.token("subject", "user-uuid-1");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("returns the same token across two tokenizers built from the same salt and pepper", async () => {
    const t1 = await createTokenizer(SALT, PEPPER);
    const t2 = await createTokenizer(SALT, PEPPER);
    const a = await t1.token("submission", 1234);
    const b = await t2.token("submission", 1234);
    expect(a).toBe(b);
  });

  it("returns different tokens when the pepper changes (salt alone is insufficient)", async () => {
    const otherPepper = "other-pepper-at-least-32-characters-long-value";
    const t1 = await createTokenizer(SALT, PEPPER);
    const t2 = await createTokenizer(SALT, otherPepper);
    const a = await t1.token("subject", "user-uuid-1");
    const b = await t2.token("subject", "user-uuid-1");
    expect(a).not.toBe(b);
  });

  it("returns different tokens across runs when the salt changes (opaque mode)", async () => {
    const s1 = generateRandomSalt();
    const s2 = generateRandomSalt();
    expect(s1).not.toBe(s2);
    const t1 = await createTokenizer(s1, PEPPER);
    const t2 = await createTokenizer(s2, PEPPER);
    const a = await t1.token("subject", "user-uuid-1");
    const b = await t2.token("subject", "user-uuid-1");
    expect(a).not.toBe(b);
  });

  it("kind-namespacing prevents collisions for same numeric id across kinds", async () => {
    const t = await createTokenizer(SALT, PEPPER);
    const submission = await t.token("submission", 1);
    const column = await t.token("gradebook_column", 1);
    const subject = await t.token("subject", 1);
    expect(submission).not.toBe(column);
    expect(submission).not.toBe(subject);
    expect(column).not.toBe(subject);
  });

  it("treats numeric and string ids consistently after coercion", async () => {
    const t = await createTokenizer(SALT, PEPPER);
    expect(await t.token("subject", 123)).toBe(await t.token("subject", "123"));
  });

  it("rejects salts shorter than 16 chars", async () => {
    await expect(createTokenizer("short", PEPPER)).rejects.toThrow(/at least 16 characters/);
  });

  it("rejects peppers shorter than 32 chars", async () => {
    await expect(createTokenizer(SALT, "short-pepper")).rejects.toThrow(/at least 32 characters/);
  });

  it("generates random salts of expected length", () => {
    const salt = generateRandomSalt();
    expect(salt).toHaveLength(52);
    expect(salt).toMatch(/^[a-z2-7]+$/);
  });

  it("base32 encodes a known vector correctly", () => {
    const bytes = new TextEncoder().encode("foobar");
    expect(base32(bytes)).toBe("mzxw6ytboi");
  });
});
