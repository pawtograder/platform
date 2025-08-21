import { createClient } from "@/utils/supabase/server";
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { userFetchAzureProfile } from "@/lib/edgeFunctions";

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
    if (!error) {
      if (data.session) {
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
                await userFetchAzureProfile({ accessToken }, supabase);
              }
            }
          } catch (error) {
            console.error("Error checking/updating Azure profile:", error);
            Sentry.captureException(error);
            // Continue with login even if profile check fails
          }
        }
      } else {
        console.log("No Azure session data returned");
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
