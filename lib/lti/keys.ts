/**
 * Tool signing key lifecycle: ensure a key exists, expose the published JWKS,
 * and load the current signing key (newest non-retired).
 */
import "server-only";
import type { KeyLike } from "jose";
import { decryptPrivateKey, generateToolKey, importSigningKey } from "./crypto";
import { ltiAdminClient, type LtiDb } from "./db";

export type SigningKey = { kid: string; alg: string; key: KeyLike };

/** Public JWKS document served at /api/lti/jwks (includes retired keys so
 *  in-flight client assertions still verify). */
export async function getPublicJwks(db: LtiDb = ltiAdminClient()): Promise<{ keys: unknown[] }> {
  await ensureSigningKey(db);
  const { data, error } = await db.from("lti_tool_keys").select("public_jwk");
  if (error) throw error;
  return { keys: (data ?? []).map((r) => r.public_jwk) };
}

/** The key we sign new assertions with: newest key that is not retired. */
export async function getCurrentSigningKey(db: LtiDb = ltiAdminClient()): Promise<SigningKey> {
  await ensureSigningKey(db);
  const { data, error } = await db
    .from("lti_tool_keys")
    .select("kid, alg, private_key_pem_encrypted, retired_at")
    .is("retired_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No active LTI tool signing key available");
  const pem = await decryptPrivateKey(data.private_key_pem_encrypted);
  return { kid: data.kid, alg: data.alg, key: await importSigningKey(pem) };
}

/** Create an initial signing key if none exist. Safe to call repeatedly. */
export async function ensureSigningKey(db: LtiDb = ltiAdminClient()): Promise<void> {
  const { count, error } = await db
    .from("lti_tool_keys")
    .select("id", { count: "exact", head: true })
    .is("retired_at", null);
  if (error) throw error;
  if ((count ?? 0) > 0) return;
  await createSigningKey(db);
}

/** Generate and persist a new signing key, returning its kid. */
export async function createSigningKey(db: LtiDb = ltiAdminClient()): Promise<string> {
  const generated = await generateToolKey();
  const { error } = await db.from("lti_tool_keys").insert({
    kid: generated.kid,
    alg: generated.alg,
    public_jwk: generated.publicJwk as never,
    private_key_pem_encrypted: generated.privateKeyPemEncrypted
  });
  if (error) throw error;
  return generated.kid;
}
