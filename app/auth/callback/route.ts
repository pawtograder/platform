import { createClient } from "@/utils/supabase/server";
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

export async function GET(request: Request) {
  // The `/auth/callback` route is required for the server-side auth flow implemented
  // by the SSR package. It exchanges an auth code for the user's session.
  // https://supabase.com/docs/guides/auth/server-side/nextjs
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session) {
      // Check if this was an Azure OAuth login and if user needs SIS ID populated
      const provider = data.session.user?.app_metadata?.provider;
      if (provider === "azure") {
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
              // Call our edge function to fetch and populate SIS ID
              const edgeFunctionUrl = `${process.env.SUPABASE_URL}/functions/v1/user-fetch-azure-profile`;
              const response = await fetch(edgeFunctionUrl, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${data.session.access_token}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ accessToken })
              });

              const result = await response.json();
              if (!result.success) {
                Sentry.captureException(new Error("Failed to fetch Azure profile: " + result.error));
                console.warn("Failed to fetch Azure profile:", result.error);
                // Continue with login even if profile fetch fails
              }
            }
          }
        } catch (error) {
          Sentry.captureException(error);
          console.error("Error checking/updating Azure profile:", error);
          // Continue with login even if profile check fails
        }
      }

      const forwardedHost = request.headers.get("x-forwarded-host"); // original origin before load balancer
      const isLocalEnv = process.env.NODE_ENV === "development";
      if (isLocalEnv) {
        // we can be sure that there is no load balancer in between, so no need to watch for X-Forwarded-Host
        return NextResponse.redirect(`${origin}${next}`);
      } else if (forwardedHost) {
        return NextResponse.redirect(`https://${forwardedHost}${next}`);
      } else {
        return NextResponse.redirect(`${origin}${next}`);
      }
    }
  }
  return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}
