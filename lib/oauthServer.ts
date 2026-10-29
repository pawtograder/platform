import "server-only";

/**
 * Pawtograder as an OAuth 2.1 / OIDC identity provider (Supabase Auth's OAuth server).
 *
 * Forgejo and Coder send the browser to GoTrue's `/oauth/authorize`, which redirects to our
 * consent page with an `authorization_id`. The consent page reads the request and records the
 * user's decision through these endpoints, called as the signed-in user.
 *
 * The installed supabase-js predates `auth.oauth.*`, so this talks to GoTrue's REST API directly.
 */

export type OAuthAuthorizationDetails = {
  authorization_id: string;
  redirect_uri: string;
  client: { id: string; name: string; uri?: string; logo_uri?: string };
  user: { id: string; email: string };
  scope: string;
};

/** The user already consented to this client and scopes: GoTrue hands back the redirect directly. */
export type OAuthAutoApproved = { redirect_url: string };

export class OAuthServerError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function authUrl(path: string) {
  const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("SUPABASE_URL is not set");
  return `${base.replace(/\/$/, "")}/auth/v1${path}`;
}

async function call<T>(path: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(authUrl(path), {
    ...init,
    cache: "no-store",
    headers: {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.msg || body?.message || body?.error_description || body?.error || res.statusText;
    throw new OAuthServerError(String(message), res.status);
  }
  return body as T;
}

export function isAutoApproved(d: OAuthAuthorizationDetails | OAuthAutoApproved): d is OAuthAutoApproved {
  return "redirect_url" in d && !("authorization_id" in d);
}

export function getAuthorizationDetails(accessToken: string, authorizationId: string) {
  return call<OAuthAuthorizationDetails | OAuthAutoApproved>(
    `/oauth/authorizations/${encodeURIComponent(authorizationId)}`,
    accessToken
  );
}

export function decideAuthorization(accessToken: string, authorizationId: string, action: "approve" | "deny") {
  return call<OAuthAutoApproved>(`/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`, accessToken, {
    method: "POST",
    body: JSON.stringify({ action })
  });
}
