/**
 * Crypto helpers for LTI tool signing keys.
 *
 * Tool private keys are stored encrypted at rest with AES-256-GCM under
 * LTI_KEY_ENCRYPTION_SECRET (32-byte base64). The public half is stored/served
 * as a JWK. Signing uses RS256 (RSA-2048), which every LTI platform supports.
 */
import { webcrypto } from "node:crypto";
import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8, type JWK } from "jose";

const ALG = "RS256";
const crypto = webcrypto as unknown as Crypto;

function getEncryptionKeyBytes(): Uint8Array {
  const secret = process.env.LTI_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("LTI_KEY_ENCRYPTION_SECRET is not configured");
  }
  const bytes = Buffer.from(secret, "base64");
  if (bytes.length !== 32) {
    throw new Error("LTI_KEY_ENCRYPTION_SECRET must decode to exactly 32 bytes (base64-encoded)");
  }
  return new Uint8Array(bytes);
}

/** AES-256-GCM encrypt → base64(iv ‖ ciphertext ‖ tag). */
export async function encryptPrivateKey(pkcs8Pem: string): Promise<string> {
  const keyBytes = getEncryptionKeyBytes();
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(pkcs8Pem))
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return Buffer.from(out).toString("base64");
}

export async function decryptPrivateKey(encrypted: string): Promise<string> {
  const keyBytes = getEncryptionKeyBytes();
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const buf = new Uint8Array(Buffer.from(encrypted, "base64"));
  const iv = buf.slice(0, 12);
  const ciphertext = buf.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export type GeneratedToolKey = {
  kid: string;
  alg: string;
  publicJwk: JWK;
  privateKeyPemEncrypted: string;
};

/** Generate a fresh RSA-2048 tool keypair, returning the encrypted private key. */
export async function generateToolKey(): Promise<GeneratedToolKey> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { modulusLength: 2048, extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = crypto.randomUUID();
  publicJwk.kid = kid;
  publicJwk.alg = ALG;
  publicJwk.use = "sig";
  const pkcs8 = await exportPKCS8(privateKey);
  return {
    kid,
    alg: ALG,
    publicJwk,
    privateKeyPemEncrypted: await encryptPrivateKey(pkcs8)
  };
}

/** Import a decrypted PKCS8 PEM into a signing key usable by jose's SignJWT. */
export async function importSigningKey(pkcs8Pem: string) {
  return importPKCS8(pkcs8Pem, ALG);
}

export { ALG as LTI_SIGNING_ALG };
