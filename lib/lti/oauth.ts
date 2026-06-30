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
// Keyed by `${platformId}:${client_id}:${token_url}:${sortedScopes}` so editing a
// platform's client_id/token_url (admin_upsert_lti_platform reuses the row id)
// can't return a bearer minted under the OLD credentials until it expires —
// which would 401 every push/sync for up to an hour on a long-running server.
const tokenCache = new Map<string, TokenCacheEntry>();

// In-flight token mints keyed by cacheKey, so concurrent callers (the grade-push
// pool runs up to 8 at once) on a cold cache share ONE client_credentials request
// instead of stampeding the platform's token endpoint with N simultaneous mints.
const inflight = new Map<string, Promise<string>>();

type PlatformAuth = { id: number; client_id: string; auth_login_url: string; token_url: string };

// Short-lived cache of the platform row so we don't issue an lti_platforms SELECT
// on every score push / NRPS page. TTL is brief so an admin edit to
// client_id/token_url takes effect within seconds (still far tighter than the
// ~1h token cache, which is keyed on the resolved credentials anyway).
const PLATFORM_CACHE_TTL_MS = 60_000;
const platformCache = new Map<number, { platform: PlatformAuth; expiresAt: number }>();

async function loadPlatform(db: LtiDb, platformId: number): Promise<PlatformAuth> {
  const cached = platformCache.get(platformId);
  if (cached && cached.expiresAt > Date.now()) return cached.platform;
  const { data, error } = await db
    .from("lti_platforms")
    .select("id, client_id, auth_login_url, token_url")
    .eq("id", platformId)
    .single();
  if (error) throw error;
  platformCache.set(platformId, { platform: data, expiresAt: Date.now() + PLATFORM_CACHE_TTL_MS });
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
  const now = Date.now();

  // Load the platform first so the cache key reflects its CURRENT credentials;
  // a stale key would hand back a token signed for an old client_id/token_url.
  const platform = await loadPlatform(db, platformId);
  const cacheKey = `${platformId}:${platform.client_id}:${platform.token_url}:${scopeStr}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 30_000) return cached.token;

  // Coalesce concurrent misses for the same key into a single mint.
  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const minted = (async () => {
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
      body,
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Token request to ${platform.token_url} failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number; token_type?: string };
    if (!json.access_token) throw new Error("Token response missing access_token");

    const ttlMs = (json.expires_in ?? 3600) * 1000;
    tokenCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + ttlMs });
    return json.access_token;
  })();

  inflight.set(cacheKey, minted);
  try {
    return await minted;
  } finally {
    // Drop the in-flight entry whether it resolved or rejected, so a failed mint
    // doesn't pin a rejected promise for subsequent callers.
    inflight.delete(cacheKey);
  }
}

/** Test seam: clear the in-memory caches. */
export function _clearTokenCache() {
  tokenCache.clear();
  platformCache.clear();
  inflight.clear();
}
