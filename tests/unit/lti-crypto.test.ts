/**
 * @jest-environment node
 */
import { decryptPrivateKey, encryptPrivateKey, generateToolKey, importSigningKey } from "@/lib/lti/crypto";

beforeAll(() => {
  // 32 bytes, base64-encoded.
  process.env.LTI_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 7).toString("base64");
});

describe("private key encryption", () => {
  test("encrypt → decrypt round-trips", async () => {
    const secret = "-----BEGIN PRIVATE KEY-----\nMIIBVerySecret\n-----END PRIVATE KEY-----\n";
    const encrypted = await encryptPrivateKey(secret);
    expect(encrypted).not.toContain("BEGIN PRIVATE KEY");
    expect(await decryptPrivateKey(encrypted)).toBe(secret);
  });

  test("ciphertext is non-deterministic (random IV)", async () => {
    const a = await encryptPrivateKey("same");
    const b = await encryptPrivateKey("same");
    expect(a).not.toBe(b);
    expect(await decryptPrivateKey(a)).toBe("same");
    expect(await decryptPrivateKey(b)).toBe("same");
  });

  test("rejects a secret of the wrong length", async () => {
    const prev = process.env.LTI_KEY_ENCRYPTION_SECRET;
    process.env.LTI_KEY_ENCRYPTION_SECRET = Buffer.alloc(16, 1).toString("base64");
    await expect(encryptPrivateKey("x")).rejects.toThrow(/32 bytes/);
    process.env.LTI_KEY_ENCRYPTION_SECRET = prev;
  });
});

describe("generateToolKey", () => {
  test("produces a usable RSA signing key and public JWK", async () => {
    const key = await generateToolKey();
    expect(key.alg).toBe("RS256");
    expect(key.kid).toBeTruthy();
    expect(key.publicJwk.kty).toBe("RSA");
    expect(key.publicJwk.kid).toBe(key.kid);
    expect(key.publicJwk.use).toBe("sig");
    // Public JWK must not leak private components.
    expect((key.publicJwk as unknown as Record<string, unknown>).d).toBeUndefined();

    // The encrypted private key decrypts to an importable PKCS8 PEM.
    const pem = await decryptPrivateKey(key.privateKeyPemEncrypted);
    expect(pem).toContain("BEGIN PRIVATE KEY");
    await expect(importSigningKey(pem)).resolves.toBeDefined();
  }, 20000);
});
