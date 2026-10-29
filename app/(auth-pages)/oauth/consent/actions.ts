"use server";

import { decideAuthorization, OAuthServerError } from "@/lib/oauthServer";
import { createClient } from "@/utils/supabase/server";
import { encodedRedirect } from "@/utils/utils";
import { redirect } from "next/navigation";

export async function decideOAuthConsentAction(formData: FormData) {
  const authorizationId = String(formData.get("authorization_id") ?? "");
  const decision = formData.get("decision") === "approve" ? "approve" : "deny";
  const consentPath = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  if (!claims?.claims || !session) {
    return redirect(`/sign-in?redirect=${encodeURIComponent(consentPath)}`);
  }

  let redirectUrl: string;
  try {
    ({ redirect_url: redirectUrl } = await decideAuthorization(session.access_token, authorizationId, decision));
  } catch (e) {
    const message = e instanceof OAuthServerError ? e.message : "Could not record your decision";
    return encodedRedirect("error", "/oauth/consent", message, { authorization_id: authorizationId });
  }
  // GoTrue returns the client's registered redirect_uri with either `code` or `error=access_denied`.
  return redirect(redirectUrl);
}
