/**
 * LTI 1.3 launch endpoint (redirect_uri / form_post target).
 *
 * Receives the platform's id_token, validates it end-to-end, records the launch
 * state, signs the user into Pawtograder, and redirects to the linked course or
 * assignment.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { ltiAdminClient } from "@/lib/lti/db";
import { verifyLaunchToken, LtiValidationError } from "@/lib/lti/jwt";
import { verifyState } from "@/lib/lti/state";
import { persistLaunch } from "@/lib/lti/launch";
import { establishSupabaseSession, resolveLaunchRedirect, LtiSessionError } from "@/lib/lti/session";
import { toolBaseUrl } from "@/lib/lti/url";
import { STATE_COOKIE } from "../login/route";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

function errorPage(message: string, status = 400): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>LTI launch failed</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}
h1{font-size:1.25rem}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}</style></head>
<body><h1>Pawtograder couldn't complete this launch</h1><p>${escapeHtml(message)}</p>
<p>If this keeps happening, contact your course administrator.</p></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage("Malformed launch request.");
  }
  const idToken = form.get("id_token");
  const state = form.get("state");

  if (typeof idToken !== "string" || typeof state !== "string") {
    return errorPage("Launch request is missing id_token or state.");
  }

  // CSRF: the state echoed by the platform must match the cookie we set at login.
  const cookieStore = await cookies();
  const cookieState = cookieStore.get(STATE_COOKIE)?.value;
  if (!cookieState || cookieState !== state) {
    return errorPage("Launch state did not match (possible CSRF or expired login). Please start again from your LMS.");
  }

  try {
    const verifiedState = await verifyState(state);
    const db = ltiAdminClient();
    const launch = await verifyLaunchToken(idToken, { expectedNonce: verifiedState.nonce, db });

    const persisted = await persistLaunch(launch, db);

    const serverClient = await createClient();
    await establishSupabaseSession(launch, serverClient, db);

    const target = resolveLaunchRedirect(persisted.classId, launch);
    const res = NextResponse.redirect(`${toolBaseUrl(request)}${target}`, { status: 302 });
    res.cookies.delete({ name: STATE_COOKIE, path: "/api/lti" });
    return res;
  } catch (e) {
    if (e instanceof LtiValidationError) {
      console.warn("[lti] launch validation failed:", e.message);
      return errorPage(`Security validation failed: ${e.message}`, 401);
    }
    if (e instanceof LtiSessionError) {
      console.warn("[lti] launch session bridge failed:", e.message);
      return errorPage(e.message, 403);
    }
    Sentry.captureException(e);
    return errorPage(`Unexpected error during launch: ${(e as Error).message}`, 500);
  }
}
