/**
 * Decode JWT payload without signature verification.
 * Used only to read `sub` / `exp` / `email` from Supabase access tokens in Edge middleware
 * where we intentionally avoid `getSession()` (refresh) calls.
 */
export type SupabaseAccessTokenPayload = {
  sub?: string;
  email?: string;
  exp?: number;
};

export function decodeJwtPayloadUnsafe(token: string): SupabaseAccessTokenPayload | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64.length % 4;
    if (pad) {
      base64 += "=".repeat(4 - pad);
    }
    const json = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(json) as SupabaseAccessTokenPayload;
  } catch {
    return null;
  }
}

export function isJwtExpired(payload: SupabaseAccessTokenPayload, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (payload.exp == null) {
    return false;
  }
  return payload.exp <= nowSeconds;
}

/**
 * When false, middleware can trust the cookie JWT and skip `getSession()` (avoids refresh-token churn).
 */
export function middlewareNeedsSupabaseGetSession(
  accessToken: string | null,
  payload: SupabaseAccessTokenPayload | null
): boolean {
  if (!accessToken) {
    return true;
  }
  if (!payload?.sub) {
    return true;
  }
  return isJwtExpired(payload);
}
