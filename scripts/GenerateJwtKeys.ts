// Generate the secret material the pawtograder Helm chart expects.
//
// Pawtograder uses asymmetric ES256 signing for user session JWTs (so the
// private signing key only ever lives on the auth pod) and HS256 for the
// long-lived API keys (ANON_KEY, SERVICE_ROLE_KEY). All four verifiers
// (gotrue, postgrest, realtime, storage) receive a JWK Set that contains
// both the EC public key and the HS256 oct key, distinguished by `kid`.
//
// Outputs:
//   JWT_SECRET        — base64 HS256 secret (ANON/SERVICE only)
//   JWT_PRIVATE_JWKS  — JSON array of private JWKs for GoTrue's GOTRUE_JWT_KEYS
//                       (single EC private key with key_ops=["sign","verify"])
//   JWT_PUBLIC_JWKS   — JSON object {"keys":[…]} for verifiers, includes the
//                       EC public key (sessions) and the HS256 oct key (apikeys)
//   ANON_KEY          — HS256 JWT, role=anon, header.kid=pawtograder-apikeys-v1
//   SERVICE_ROLE_KEY  — HS256 JWT, role=service_role, same kid
//
// Usage:
//   npx tsx scripts/GenerateJwtKeys.ts                  # human-readable
//   npx tsx scripts/GenerateJwtKeys.ts --env            # KEY=value lines
//   npx tsx scripts/GenerateJwtKeys.ts --helm-values    # YAML snippet for
//                                                      #   `helm install -f`
//   npx tsx scripts/GenerateJwtKeys.ts --kv <vault path> # OpenBao kv-put cmd

import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";

const TEN_YEARS_SECONDS = 60 * 60 * 24 * 365 * 10;
const SESSION_KID = "pawtograder-session-v1";
const APIKEYS_KID = "pawtograder-apikeys-v1";

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signHS256(secret: string, payload: Record<string, unknown>, kid: string): string {
  const header = { alg: "HS256", typ: "JWT", kid };
  const headerEncoded = b64url(JSON.stringify(header));
  const payloadEncoded = b64url(JSON.stringify(payload));
  const data = `${headerEncoded}.${payloadEncoded}`;
  const sig = b64url(createHmac("sha256", secret).update(data).digest());
  return `${data}.${sig}`;
}

// --- ES256 (P-256) keypair, exported as JWKs ---
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256"
});
const privateJwk = privateKey.export({ format: "jwk" }) as Record<string, string>;
const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, string>;

// Add the metadata GoTrue and verifiers expect.
const ecPrivate = {
  ...privateJwk,
  kid: SESSION_KID,
  alg: "ES256",
  use: "sig",
  key_ops: ["sign", "verify"]
};
const ecPublic = {
  ...publicJwk,
  kid: SESSION_KID,
  alg: "ES256",
  use: "sig",
  key_ops: ["verify"]
};

// --- HS256 oct key (for the long-lived API keys) ---
const hsSecret = randomBytes(48).toString("base64");

// --- AES-128 key for Realtime's tenant secret encryption (must be 16 bytes) ---
const realtimeEncKey = randomBytes(16).toString("base64").slice(0, 16);

// --- AES-256 key for pg-meta to encrypt saved DB connection strings ---
// Used by Studio's Database/SQL-editor pages; without it those pages 500.
const pgMetaCryptoKey = randomBytes(32).toString("base64");

// --- 32-byte hex key for pgsodium; postgres mounts it as a file ---
const pgsodiumRootKey = randomBytes(32).toString("hex");

// --- Postgres + application-role passwords, URL-safe ---
const safePass = (n: number) => randomBytes(n).toString("base64").replace(/[/+=]/g, "").slice(0, 32);
const postgresPassword = safePass(24);
const pawtograderPassword = safePass(24);

// --- E2E load-test secrets (used only when edgeFunctions.e2e.enabled) ---
const endToEndSecret = randomBytes(32).toString("hex");
const edgeFunctionSecret = randomBytes(32).toString("hex");
const octPublic = {
  kty: "oct",
  k: b64url(hsSecret),
  kid: APIKEYS_KID,
  alg: "HS256",
  use: "sig",
  key_ops: ["verify"]
};

// --- The two artefacts components consume ---
// GoTrue takes a JSON ARRAY of private JWKs in GOTRUE_JWT_KEYS. Only one
// key has key_ops including "sign" — the EC key signs new session JWTs.
// The oct key is included verify-only so GoTrue can validate the
// HS256-signed long-lived ANON/SERVICE_ROLE keys clients send.
const privateJwks = JSON.stringify([ecPrivate, octPublic]);
// Verifiers take a JWK Set object {"keys":[…]} with public material only.
const publicJwks = JSON.stringify({ keys: [ecPublic, octPublic] });
// Realtime gets EC-only: its Joken pin (v2.5.0) doesn't accept JWK maps for
// HS-family algorithms and raises "Couldn't recognize the signer algorithm".
// With EC-only in the tenant's jwt_jwks, ES256 sessions verify against the
// EC key, and HS256 API keys fall back to jwt_secret (which works fine).
const realtimeJwks = JSON.stringify({ keys: [ecPublic] });

// --- Long-lived API keys, signed HS256 with the apikeys oct key ---
const now = Math.floor(Date.now() / 1000);
const exp = now + TEN_YEARS_SECONDS;

const anonKey = signHS256(hsSecret, { iss: "supabase", ref: "pawtograder", role: "anon", iat: now, exp }, APIKEYS_KID);
const serviceRoleKey = signHS256(
  hsSecret,
  { iss: "supabase", ref: "pawtograder", role: "service_role", iat: now, exp },
  APIKEYS_KID
);

// --- Output ---
const args = process.argv.slice(2);
const mode: "plain" | "env" | "kv" | "helm" = args.includes("--env")
  ? "env"
  : args.includes("--helm-values")
    ? "helm"
    : args.includes("--kv")
      ? "kv"
      : "plain";
const kvPath = mode === "kv" ? args[args.indexOf("--kv") + 1] : null;
if (mode === "kv" && !kvPath) {
  console.error("--kv requires a path argument (e.g. kv/apps/pawtograder-staging/jwt)");
  process.exit(2);
}

if (mode === "env") {
  console.log(`JWT_SECRET=${hsSecret}`);
  console.log(`JWT_PRIVATE_JWKS=${privateJwks}`);
  console.log(`JWT_PUBLIC_JWKS=${publicJwks}`);
  console.log(`JWT_REALTIME_JWKS=${realtimeJwks}`);
  console.log(`ANON_KEY=${anonKey}`);
  console.log(`SERVICE_ROLE_KEY=${serviceRoleKey}`);
  console.log(`REALTIME_ENC_KEY=${realtimeEncKey}`);
  console.log(`PG_META_CRYPTO_KEY=${pgMetaCryptoKey}`);
  console.log(`PGSODIUM_ROOT_KEY=${pgsodiumRootKey}`);
  console.log(`POSTGRES_PASSWORD=${postgresPassword}`);
  console.log(`PAWTOGRADER_PASSWORD=${pawtograderPassword}`);
  console.log(`END_TO_END_SECRET=${endToEndSecret}`);
  console.log(`EDGE_FUNCTION_SECRET=${edgeFunctionSecret}`);
} else if (mode === "helm") {
  // YAML snippet that can be passed via `helm install -f` together with the
  // chart's other values. Single-quoted scalars preserve the JSON exactly.
  const escSingle = (s: string) => s.replaceAll("'", "''");
  console.log("# Generated by scripts/GenerateJwtKeys.ts. Treat as secret.");
  console.log("secrets:");
  console.log("  create: true");
  console.log("  values:");
  console.log("    jwt:");
  console.log(`      secret: '${escSingle(hsSecret)}'`);
  console.log(`      anonKey: '${escSingle(anonKey)}'`);
  console.log(`      serviceRoleKey: '${escSingle(serviceRoleKey)}'`);
  console.log(`      privateJwks: '${escSingle(privateJwks)}'`);
  console.log(`      publicJwks: '${escSingle(publicJwks)}'`);
} else if (mode === "kv") {
  // bao kv put accepts @file or KEY=value pairs; large JSON values escape
  // poorly on a single shell line, so use stdin-based input.
  console.log(`# Pipe this script's --env output to bao via:`);
  console.log(`#   npx tsx scripts/GenerateJwtKeys.ts --env | bao kv put ${kvPath} -`);
  console.log(`# Or run individual puts:`);
  console.log(`bao kv put ${kvPath} \\`);
  console.log(`  JWT_SECRET='${hsSecret}' \\`);
  console.log(`  ANON_KEY='${anonKey}' \\`);
  console.log(`  SERVICE_ROLE_KEY='${serviceRoleKey}' \\`);
  console.log(`  JWT_PRIVATE_JWKS='${privateJwks}' \\`);
  console.log(`  JWT_PUBLIC_JWKS='${publicJwks}'`);
} else {
  console.log("JWT_SECRET (HS256, used for ANON/SERVICE keys only):");
  console.log(`  ${hsSecret}`);
  console.log("");
  console.log("JWT_PRIVATE_JWKS (GoTrue GOTRUE_JWT_KEYS — keep secret):");
  console.log(`  ${privateJwks}`);
  console.log("");
  console.log("JWT_PUBLIC_JWKS (verifiers — public, mountable as file):");
  console.log(`  ${publicJwks}`);
  console.log("");
  console.log("ANON_KEY (sent by clients):");
  console.log(`  ${anonKey}`);
  console.log("");
  console.log("SERVICE_ROLE_KEY (server-side admin):");
  console.log(`  ${serviceRoleKey}`);
  console.log("");
  console.log(`API key expiry: ${new Date(exp * 1000).toISOString()}`);
  console.log(`Session signing kid: ${SESSION_KID}`);
  console.log(`API key signing kid: ${APIKEYS_KID}`);
}
