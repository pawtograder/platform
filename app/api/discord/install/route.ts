/**
 * Start the Discord bot install for a class.
 *
 * The Discord half of GitHub App installation. An instructor used to connect a class to a Discord
 * server by typing a guild snowflake into a text box, which authorized nothing: one bot token serves
 * every course on the deployment, so any guild the bot was already in -- including another course's
 * server -- could be claimed by anyone who could edit the class. This route replaces that with proof
 * of control: the instructor is sent to Discord's own consent screen and adds the bot themselves,
 * which requires Manage Server on the guild they pick.
 *
 * Deliberately no `guild_id` on the authorize URL. Pinning the consent screen to a guild we were
 * handed would remove the server picker, and the picker is exactly what makes this an authorization
 * step: Discord only lists servers the signed-in Discord user may add a bot to. (The re-authorize
 * link on the settings page does pass `guild_id`, via the edge function's `install_url`, because
 * there the class already owns the guild and narrowing the choice is the safer option.)
 *
 * The return trip is `app/api/discord/install/callback/route.ts`.
 */
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/utils/supabase/server";
// The canonical instructor gate -- authorizeforclassinstructor() / authorize_for_admin() -- rather
// than a hand-rolled user_roles query that can drift from them. It lives under lib/lti only because
// LTI needed it first; nothing about it is LTI-specific.
import { isInstructorOfClass } from "@/lib/lti/auth";
import { botInstallUrl } from "@/supabase/functions/_shared/DiscordPermissions";
import {
  DISCORD_INSTALL_NONCE_COOKIE,
  DISCORD_INSTALL_NONCE_COOKIE_MAX_AGE,
  DISCORD_INSTALL_NONCE_COOKIE_PATH,
  createInstallState,
  randomInstallNonce
} from "@/lib/discordInstallState";
import { installCallbackUrl, redirectOrigin } from "@/lib/discordInstall";

export const dynamic = "force-dynamic";

// A per-install redirect carrying a signed state must never be cached by a browser, CDN, or proxy.
// Same reasoning as app/api/lti/login/route.ts.
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request) {
  const scope = Sentry.getCurrentScope();
  scope.setTag("endpoint", "discord_install");

  const classIdParam = new URL(request.url).searchParams.get("class_id");
  const classId = Number(classIdParam);
  // `Number("")` is 0 and `Number("1e3")` is 1000, so the shape is checked rather than just the
  // parse: this id ends up inside a signed state and in a redirect path.
  if (!classIdParam || !/^\d+$/.test(classIdParam) || !Number.isSafeInteger(classId) || classId <= 0) {
    return NextResponse.json({ error: "class_id is required" }, { status: 400, headers: NO_STORE });
  }
  scope.setTag("class_id", String(classId));

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    // The likeliest failure by far is an expired session on a page that has been open a while, so
    // send them to sign in and back rather than showing raw JSON.
    const back = `/api/discord/install?class_id=${classId}`;
    return NextResponse.redirect(`${redirectOrigin(request)}/sign-in?redirect=${encodeURIComponent(back)}`, {
      status: 302,
      headers: NO_STORE
    });
  }

  // Authorized BEFORE the state is minted. A signed state is a capability -- the callback treats it
  // as proof that this user asked for this class -- so it must never exist for a class the user has
  // no standing in, even though the callback checks again.
  if (!(await isInstructorOfClass(supabase, classId))) {
    return NextResponse.json(
      { error: "You must be an instructor of this course to connect a Discord server." },
      { status: 403, headers: NO_STORE }
    );
  }

  // Every credential the ROUND TRIP needs, checked here rather than only the one this leg needs.
  //
  // The callback cannot record a claim without the OAuth client secret (it redeems the authorization
  // code) or the bot token (it confirms the bot is really in the guild), and it reports both as
  // "Discord could not be reached" -- a message that invites a retry which cannot ever pass. Checking
  // them only there meant the instructor was sent to Discord, granted the bot real permissions on
  // their own server, came back, and was told to try again. Failing before the state is minted keeps
  // a misconfigured deployment from making an irreversible change on somebody else's Discord server
  // and then disowning it.
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const missingConfig = [
    ["DISCORD_APPLICATION_ID", applicationId],
    // Falls back to DISCORD_APPLICATION_ID in exchangeInstallCode(), so it is only missing when both are.
    ["DISCORD_OAUTH_CLIENT_ID", process.env.DISCORD_OAUTH_CLIENT_ID ?? applicationId],
    ["DISCORD_OAUTH_CLIENT_SECRET", process.env.DISCORD_OAUTH_CLIENT_SECRET],
    ["DISCORD_BOT_TOKEN", process.env.DISCORD_BOT_TOKEN]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (!applicationId || missingConfig.length > 0) {
    // Reported, not silently degraded: without these there is no consent screen to send anyone to, or
    // no way to confirm what came back, and the button would appear to do nothing.
    Sentry.captureMessage(`Discord install unavailable; unset: ${missingConfig.join(", ")}`, {
      level: "error"
    });
    return NextResponse.json(
      {
        error: `Discord is not fully configured on this deployment, so a server cannot be connected (unset: ${missingConfig.join(", ")}).`
      },
      { status: 500, headers: NO_STORE }
    );
  }

  const nonce = randomInstallNonce();
  const state = await createInstallState({ classId, userId: user.id, nonce });

  // The permission bits and the authorize endpoint both come from the shared constant, so the
  // consent screen asks for exactly the set the install check audits and the settings page lists.
  // `state`, `redirect_uri` and `response_type` are added here rather than there because they are
  // properties of this round-trip, not of the bot: without a redirect_uri Discord shows an
  // "Authorized" page and never comes back, which is how the old flow had no callback to secure.
  const authorizeUrl = new URL(botInstallUrl({ applicationId }));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", installCallbackUrl(request));
  authorizeUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authorizeUrl.toString(), { status: 302 });
  response.headers.set("Cache-Control", "no-store");
  // Binds the state to this browser and makes it single-use: the callback requires this value to
  // match the nonce inside the signed state, then clears it. Without it a state lifted from a
  // referrer or a shared screen would be replayable for its full ten minutes. `lax` because the
  // return leg is a top-level GET navigation from discord.com, which lax sends.
  response.cookies.set(DISCORD_INSTALL_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    path: DISCORD_INSTALL_NONCE_COOKIE_PATH,
    maxAge: DISCORD_INSTALL_NONCE_COOKIE_MAX_AGE
  });
  return response;
}
