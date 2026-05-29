/**
 * OIDC third-party login initiation (LTI 1.3).
 *
 * The platform redirects the browser here (GET or POST form) to begin a launch.
 * We look up the platform by issuer, generate a CSRF `state` (also set as a
 * cookie) and a `nonce`, then redirect to the platform's authentication
 * endpoint requesting an implicit `id_token` returned via form_post.
 *
 * Spec: https://www.imsglobal.org/spec/security/v1p0#step-1-third-party-initiated-login
 */
import { NextResponse } from "next/server";
import { ltiAdminClient } from "@/lib/lti/db";
import { createState, randomNonce } from "@/lib/lti/state";
import { toolBaseUrl } from "@/lib/lti/url";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "lti_state";

async function readParams(request: Request): Promise<URLSearchParams> {
  if (request.method === "POST") {
    const form = await request.formData();
    const params = new URLSearchParams();
    for (const [k, v] of form.entries()) params.set(k, String(v));
    return params;
  }
  return new URL(request.url).searchParams;
}

async function handle(request: Request) {
  const params = await readParams(request);
  const iss = params.get("iss");
  const loginHint = params.get("login_hint");
  const targetLinkUri = params.get("target_link_uri") ?? undefined;
  const ltiMessageHint = params.get("lti_message_hint") ?? undefined;
  const clientIdParam = params.get("client_id") ?? undefined;

  if (!iss || !loginHint) {
    return NextResponse.json({ error: "Missing required login parameters (iss, login_hint)" }, { status: 400 });
  }

  const db = ltiAdminClient();
  let query = db
    .from("lti_platforms")
    .select("id, issuer, client_id, auth_login_url, enabled")
    .eq("issuer", iss)
    .eq("enabled", true);
  if (clientIdParam) query = query.eq("client_id", clientIdParam);
  const { data: platforms, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const platform = platforms?.[0];
  if (!platform) {
    return NextResponse.json({ error: `No enabled LTI platform registered for issuer ${iss}` }, { status: 400 });
  }

  const nonce = randomNonce();
  const state = await createState({ nonce, iss, clientId: platform.client_id, targetLinkUri });

  const authUrl = new URL(platform.auth_login_url);
  authUrl.searchParams.set("scope", "openid");
  authUrl.searchParams.set("response_type", "id_token");
  authUrl.searchParams.set("response_mode", "form_post");
  authUrl.searchParams.set("prompt", "none");
  authUrl.searchParams.set("client_id", platform.client_id);
  authUrl.searchParams.set("redirect_uri", `${toolBaseUrl(request)}/api/lti/launch`);
  authUrl.searchParams.set("login_hint", loginHint);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  if (ltiMessageHint) authUrl.searchParams.set("lti_message_hint", ltiMessageHint);

  const res = NextResponse.redirect(authUrl.toString(), { status: 302 });
  // Bind the state to this browser; SameSite=None because the launch is a
  // cross-site POST back from the LMS.
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/api/lti",
    maxAge: 600
  });
  return res;
}

export async function GET(request: Request) {
  return handle(request);
}
export async function POST(request: Request) {
  return handle(request);
}

export { STATE_COOKIE };
