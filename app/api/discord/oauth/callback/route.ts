import { createClient } from "@/utils/supabase/server";
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

function getRedirectUrl(request: Request, origin: string, path: string): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const isLocalEnv = process.env.NODE_ENV === "development";
  if (isLocalEnv) {
    return `${origin}${path}`;
  } else if (forwardedHost) {
    return `https://${forwardedHost}${path}`;
  } else {
    return `${origin}${path}`;
  }
}

export async function GET(request: Request) {
  // The `/api/discord/oauth/callback` route handles the Discord OAuth callback
  // for linking Discord accounts to existing user accounts.
  //
  // Discord user info (discord_id, discord_username) is automatically extracted
  // from the identity data by a database trigger (update_discord_profile_trigger),
  // similar to how we handle GitHub OAuth.
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = "/course";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Success - the database trigger will automatically update
      // discord_id and discord_username in the users table
      return NextResponse.redirect(getRedirectUrl(request, origin, next));
    } else {
      console.error("Discord OAuth error:", error);
      Sentry.captureException(error, {
        tags: { oauth_provider: "discord" }
      });
    }
  }

  return NextResponse.redirect(
    getRedirectUrl(request, origin, `/course?error_description=${encodeURIComponent("Discord authentication failed")}`)
  );
}
