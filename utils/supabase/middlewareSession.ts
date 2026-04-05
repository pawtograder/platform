import { stringFromBase64URL } from "@supabase/ssr";

const BASE64_PREFIX = "base64-";

export type CookiePair = { name: string; value: string };

/** Mirrors @supabase/ssr combineChunks for request cookies (sync). */
function combineSessionCookieValue(key: string, getChunk: (name: string) => string | undefined): string | null {
  const whole = getChunk(key);
  if (whole) {
    return whole;
  }
  const parts: string[] = [];
  for (let i = 0; ; i++) {
    const chunk = getChunk(`${key}.${i}`);
    if (!chunk) {
      break;
    }
    parts.push(chunk);
  }
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * Cookie storage key used by @supabase/supabase-js for browser/SSR sessions.
 * Must match SupabaseClient default: `sb-<project-ref>-auth-token`.
 */
export function supabaseAuthCookieStorageKeyFromUrl(supabaseUrl: string): string {
  const host = new URL(supabaseUrl).hostname;
  const projectRef = host.split(".")[0];
  return `sb-${projectRef}-auth-token`;
}

type SessionCookiePayload = {
  access_token?: string;
  expires_at?: number;
};

/**
 * Read the access token from Supabase SSR auth cookies without calling
 * `getSession()` / `getClaims()` (which can trigger refresh-token requests
 * when the access token is inside GoTrue's expiry margin).
 */
export function readAccessTokenFromCookiePairs(cookies: CookiePair[], storageKey: string): string | null {
  const byName = new Map(cookies.map((c) => [c.name, c.value]));
  const raw = combineSessionCookieValue(storageKey, (name) => byName.get(name));

  if (!raw) {
    return null;
  }

  let jsonStr = raw;
  if (typeof raw === "string" && raw.startsWith(BASE64_PREFIX)) {
    try {
      jsonStr = stringFromBase64URL(raw.substring(BASE64_PREFIX.length));
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonStr) as SessionCookiePayload;
    return typeof parsed.access_token === "string" ? parsed.access_token : null;
  } catch {
    return null;
  }
}

export function readAccessTokenFromSupabaseCookies(
  request: { cookies: { getAll(): CookiePair[] } },
  storageKey: string
): string | null {
  return readAccessTokenFromCookiePairs(request.cookies.getAll(), storageKey);
}
