/**
 * OAuth2 client-credentials access tokens for LTI Advantage services (NRPS/AGS).
 *
 * LTI 1.3 uses asymmetric client authentication: we mint a short-lived JWT
 * (signed with our tool key), send it as `client_assertion`, and the platform
 * returns a bearer access token scoped to the requested service scopes.
 *
 * Spec: https://www.imsglobal.org/spec/security/v1p0#using-json-web-tokens-with-oauth-2-0-client-credentials-grant
 */
import { SignJWT } from "jose";
import { getCurrentSigningKey } from "./keys";
import { ltiAdminClient, type LtiDb } from "./db";

const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

type TokenCacheEntry = { token: string; expiresAt: number };
// keyed by `${platformId}:${sortedScopes}`
const tokenCache = new Map<string, TokenCacheEntry>();

type PlatformAuth = { id: number; client_id: string; auth_login_url: string; token_url: string };

async function loadPlatform(db: LtiDb, platformId: number): Promise<PlatformAuth> {
  const { data, error } = await db
    .from("lti_platforms")
    .select("id, client_id, auth_login_url, token_url")
    .eq("id", platformId)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Get (and cache) an access token for the given platform + scopes.
 * The platform `aud` for the client assertion is its token endpoint, per spec.
 */
export async function getServiceAccessToken(
  platformId: number,
  scopes: string[],
  db: LtiDb = ltiAdminClient()
): Promise<string> {
  const scopeStr = [...scopes].sort().join(" ");
  const cacheKey = `${platformId}:${scopeStr}`;
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 30_000) return cached.token;

  const platform = await loadPlatform(db, platformId);
  const signing = await getCurrentSigningKey(db);

  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: signing.alg, kid: signing.kid, typ: "JWT" })
    .setIssuer(platform.client_id)
    .setSubject(platform.client_id)
    .setAudience([platform.token_url, platform.auth_login_url])
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(crypto.randomUUID())
    .sign(signing.key);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: assertion,
    scope: scopeStr
  });

  const res = await fetch(platform.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token request to ${platform.token_url} failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number; token_type?: string };
  if (!json.access_token) throw new Error("Token response missing access_token");

  const ttlMs = (json.expires_in ?? 3600) * 1000;
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: now + ttlMs });
  return json.access_token;
}

/** Test seam: clear the in-memory token cache. */
export function _clearTokenCache() {
  tokenCache.clear();
}
