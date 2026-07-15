import { createClient } from "@/utils/supabase/server";
import { NextResponse, after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { syncGitHubAccount, userFetchAzureProfile } from "@/lib/edgeFunctions";
import { findGithubIdentity } from "@/lib/githubIdentity";

export async function GET(request: Request) {
  // The `/auth/callback` route is required for the server-side auth flow implemented
  // by the SSR package. It exchanges an auth code for the user's session.
  // https://supabase.com/docs/guides/auth/server-side/nextjs
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next") ?? "/";
  const next = nextParam.startsWith("/") ? nextParam : "/";
  // Resolve the redirect host once: behind the load balancer, prefer X-Forwarded-Host.
  const forwardedHost = request.headers.get("x-forwarded-host"); // original origin before load balancer
  const isLocalEnv = process.env.NODE_ENV === "development";
  // Local dev has no load balancer, so X-Forwarded-Host doesn't apply.
  const redirectBase = isLocalEnv ? origin : forwardedHost ? `https://${forwardedHost}` : origin;

  // OAuth/link providers redirect back with `error`/`error_description` (and no `code`) when the user
  // cancels or denies the flow. Since the course GitHub-link banner (components/github/link-account.tsx)
  // now redirects here with `next=/course/{id}` — and its UI renders `error_description` — forward
  // those params back to `next` so the user lands on the originating page with the actionable message.
  // Only do this when a specific `next` page was requested; a plain login error (no `next`) still goes
  // to the dedicated /auth/auth-code-error page below.
  const authError = searchParams.get("error");
  const authErrorDescription = searchParams.get("error_description");
  if (!code && authError && next !== "/") {
    const dest = new URL(next, redirectBase);
    dest.searchParams.set("error", authError);
    if (authErrorDescription) dest.searchParams.set("error_description", authErrorDescription);
    return NextResponse.redirect(dest);
  }

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (data.session) {
        // Check if this was an Azure OAuth login and if user needs SIS ID populated
        // Decode provider_token JWT to determine issuer (iss) and check if Azure
        let isAzure = false;
        const providerToken = data.session.provider_token;
        if (providerToken) {
          // JWT format: header.payload.signature
          const parts = providerToken.split(".");
          if (parts.length === 3) {
            try {
              const b64url = parts[1];
              const b64 = b64url
                .replace(/-/g, "+")
                .replace(/_/g, "/")
                .padEnd(Math.ceil(b64url.length / 4) * 4, "=");
              const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
              // Azure AD tokens typically have iss like "https://sts.windows.net/{tenantid}/"
              if (payload.iss && typeof payload.iss === "string" && payload.iss.includes("sts.windows.net")) {
                isAzure = true;
              }
            } catch (e) {
              console.error("Failed to decode provider_token JWT:", e);
            }
          }
        }
        if (isAzure) {
          try {
            // Check if user already has sis_user_id
            const { data: userData } = await supabase
              .from("users")
              .select("sis_user_id")
              .eq("user_id", data.session.user.id)
              .single();

            // If no SIS ID, try to fetch from Azure
            if (!userData?.sis_user_id) {
              const accessToken = data.session.provider_token;
              if (accessToken) {
                await userFetchAzureProfile({ accessToken }, supabase);
              }
            }
          } catch (error) {
            console.error("Error checking/updating Azure profile:", error);
            Sentry.captureException(error);
            // Continue with login even if profile check fails
          }
        }

        // Reconcile the user's existing GitHub org/team memberships on login. A user already a
        // member of the course's GitHub org (joined via another class, or added out-of-band) would
        // otherwise be stuck on the "accept your invitation" banner forever, since an invite can't
        // be sent to an existing member. Invoking github-user-sync runs the same reconciliation as
        // the manual "Sync GitHub Account" button (spans all enrolled orgs, flips
        // github_org_confirmed for orgs they're already in).
        //
        // Detect a *linked* GitHub identity, not just the primary login provider: SSO/email users
        // who later link GitHub (linkGitHubAction -> linkIdentity) come back through this callback
        // with GitHub as a secondary identity while app_metadata.provider stays their original
        // provider.
        const providers = data.session.user.app_metadata?.providers;
        const hasGitHubIdentity =
          !!findGithubIdentity(data.session.user.identities) ||
          data.session.user.app_metadata?.provider === "github" ||
          (Array.isArray(providers) && providers.includes("github"));

        if (hasGitHubIdentity) {
          const userId = data.session.user.id;
          // Run in the background (after the response) so the several GitHub round-trips never delay
          // the login redirect and can't cause auth timeouts. Gate on the presence of an
          // unconfirmed enrollment — the banner's own condition — rather than a synced-timestamp, so
          // a run that failed part-way (e.g. a transient GitHub error after github-user-sync already
          // stamped last_github_user_sync) is retried on the next login instead of being skipped
          // forever. Reconciliation is idempotent; errors are logged, never surfaced to login.
          after(async () => {
            try {
              // Only reconcile when the user has an unconfirmed enrollment in a class that actually
              // uses GitHub (github_org is set). Without the github_org filter, a GitHub-linked user
              // enrolled only in non-GitHub classes keeps github_org_confirmed = false forever, so this
              // would invoke github-user-sync on every login just for it to throw "User not in any
              // classes" (wasted round-trip + Sentry noise). Treat NULL github_org_confirmed as
              // unconfirmed too (the column is nullable), matching the invitation banner's own condition
              // (resend-org-invitation.tsx hides only when github_org_confirmed is truthy).
              const { data: unconfirmed, error: fetchError } = await supabase
                .from("classes")
                .select("id, user_roles!inner(id)")
                .not("github_org", "is", null)
                .eq("user_roles.user_id", userId)
                .eq("user_roles.disabled", false)
                .not("user_roles.github_org_confirmed", "is", true)
                .limit(1);
              // Supabase queries don't throw; surface the error so the catch reports it to Sentry.
              if (fetchError) throw fetchError;
              if (unconfirmed && unconfirmed.length > 0) {
                await syncGitHubAccount(supabase);
              }
            } catch (error) {
              console.error("Background GitHub org reconciliation failed:", error);
              Sentry.captureException(error);
            }
          });
        }
      } else {
        console.log("No Azure session data returned");
      }

      return NextResponse.redirect(`${redirectBase}${next}`);
    }
  }
  return NextResponse.redirect(`${redirectBase}/auth/auth-code-error`);
}
