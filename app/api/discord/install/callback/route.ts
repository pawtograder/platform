/**
 * Finish the Discord bot install and record the class's claim on the guild.
 *
 * Discord returns the browser here after the instructor adds the bot, with `code`, `guild_id`,
 * `permissions` and the `state` we minted in `app/api/discord/install/route.ts`. Almost none of that
 * is evidence on its own -- the query string is attacker-authorable, since it arrives as a plain GET
 * the instructor's browser can be pointed at -- so every step below fails closed and the claim only
 * happens once all five have passed:
 *
 *   1. the state verifies (signature, expiry) and its nonce matches this browser's cookie,
 *   2. the caller is *still* an instructor of the class in the state,
 *   3. the authorization `code` redeems, and the guild is taken from Discord's token response,
 *   4. the bot token can see that guild, and
 *   5. claim_discord_guild() accepts the pair.
 *
 * Step 2 is not redundant with step 1. The state proves the flow was started for this class by this
 * user; it says nothing about whether that is still true ten minutes later, and an enrollment can be
 * disabled in between.
 *
 * Step 3 is not redundant with step 4, and is the one that makes the guild trustworthy. One bot token
 * serves every course, so step 4 would happily confirm any guild the bot already sits in -- which is
 * every guild any course has ever connected. Only the authorization code ties this callback to the
 * consent screen the instructor actually completed. `guild_id` from the query string is used for
 * cross-checking and logging, never to decide what is claimed.
 */
import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/client";
import { isInstructorOfClass } from "@/lib/lti/auth";
import {
  DISCORD_INSTALL_NONCE_COOKIE,
  DISCORD_INSTALL_NONCE_COOKIE_PATH,
  verifyInstallState
} from "@/lib/discordInstallState";
import { exchangeInstallCode, lookupGuildAsBot, manageDiscordPageUrl, redirectOrigin } from "@/lib/discordInstall";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** What claim_discord_guild() returns. One row. */
type ClaimRow = {
  class_id: number;
  guild_id: string;
  claimed_by: string | null;
  claimed_at: string;
  previous_guild_id: string | null;
};

/**
 * Every response clears the nonce cookie.
 *
 * The state is single-use whether or not it worked: leaving the cookie behind after a failure would
 * let a state be retried until it expired, which is the replay this flow is built to refuse. Set to
 * empty with maxAge 0 rather than deleted by name so the path matches the one it was written on --
 * a delete on the wrong path is a silent no-op.
 */
function clearNonce(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(DISCORD_INSTALL_NONCE_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    path: DISCORD_INSTALL_NONCE_COOKIE_PATH,
    maxAge: 0
  });
  return response;
}

export async function GET(request: NextRequest) {
  const scope = Sentry.getCurrentScope();
  scope.setTag("endpoint", "discord_install_callback");

  const { searchParams } = new URL(request.url);
  const stateParam = searchParams.get("state");
  // Read for cross-checking and logging only. The guild that actually gets claimed comes from the
  // authorization-code exchange further down, never from here.
  const guildId = searchParams.get("guild_id");
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error");
  const oauthErrorDescription = searchParams.get("error_description");

  // ---------------------------------------------------------------------------
  // 1. The state, and only then anything derived from it
  // ---------------------------------------------------------------------------

  // No verified state means no trustworthy class id, so there is no settings page to redirect to --
  // a class id read straight from the query string would be an unauthenticated redirect target. JSON
  // is the honest answer here even though it is the uglier one.
  if (!stateParam) {
    return clearNonce(NextResponse.json({ error: "Missing state" }, { status: 400, headers: NO_STORE }));
  }

  let state;
  try {
    state = await verifyInstallState(stateParam);
  } catch (e) {
    scope.setTag("error_type", "invalid_state");
    Sentry.captureMessage("Discord install callback rejected an unverifiable state", { level: "warning" });
    // eslint-disable-next-line no-console
    console.warn("[discord install] state verification failed:", e instanceof Error ? e.message : e);
    return clearNonce(
      NextResponse.json(
        { error: "This Discord installation link is invalid or has expired. Start again from the course settings." },
        { status: 400, headers: NO_STORE }
      )
    );
  }
  const classId = state.classId;
  scope.setTag("class_id", String(classId));

  // The nonce cookie. Its absence is as disqualifying as a mismatch: it means this browser did not
  // start the flow, which is what a replayed or planted callback URL looks like.
  const cookieNonce = request.cookies.get(DISCORD_INSTALL_NONCE_COOKIE)?.value;
  if (!cookieNonce || cookieNonce !== state.nonce) {
    scope.setTag("error_type", "nonce_mismatch");
    Sentry.captureMessage("Discord install callback nonce did not match", { level: "warning" });
    return clearNonce(
      NextResponse.json(
        { error: "This Discord installation link has already been used or was not started here." },
        { status: 400, headers: NO_STORE }
      )
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Current standing, not the standing recorded in the state
  // ---------------------------------------------------------------------------

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    // Back to the start of the flow, not to this callback: the state and its nonce are spent by the
    // time they get here, so replaying the callback after signing in would only fail again.
    const back = `/api/discord/install?class_id=${classId}`;
    return clearNonce(
      NextResponse.redirect(`${redirectOrigin(request)}/sign-in?redirect=${encodeURIComponent(back)}`, { status: 302 })
    );
  }
  // Same person who started it. The state names a user, and honouring it for a different session
  // would let one instructor's abandoned flow be completed by whoever used the machine next.
  if (user.id !== state.userId) {
    scope.setTag("error_type", "state_user_mismatch");
    return clearNonce(
      NextResponse.json(
        { error: "This Discord installation was started by a different account." },
        { status: 403, headers: NO_STORE }
      )
    );
  }
  if (!(await isInstructorOfClass(supabase, classId))) {
    scope.setTag("error_type", "not_instructor");
    return clearNonce(
      NextResponse.json(
        { error: "You must be an instructor of this course to connect a Discord server." },
        { status: 403, headers: NO_STORE }
      )
    );
  }

  // Past this point the class id is verified, so failures can land on its settings page with a
  // message instead of raw JSON.
  const fail = (description: string) =>
    clearNonce(
      NextResponse.redirect(
        manageDiscordPageUrl(request, classId, { error: "discord_install_failed", errorDescription: description }),
        { status: 302 }
      )
    );

  // The instructor declined on Discord's consent screen, or Discord refused the request. Reported
  // with Discord's own wording where it gave any, because "access_denied" alone reads as a bug.
  if (oauthError) {
    scope.setTag("error_type", "oauth_error");
    return fail(
      oauthError === "access_denied"
        ? "The Discord installation was cancelled, so nothing was connected."
        : `Discord refused the installation: ${oauthErrorDescription ?? oauthError}`
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Redeem the authorization code, and take the guild from Discord's answer
  // ---------------------------------------------------------------------------

  // The `guild_id` query parameter is NOT used to decide what gets claimed. It arrives in a URL the
  // instructor's browser can be handed by anyone, and the bot-token lookup below would confirm any
  // guild the shared bot already sits in -- which is every guild any course has ever connected. The
  // authorization code is the only part of this redirect that Discord issued to the browser that
  // actually completed the consent screen, so the guild named in the token response is the one the
  // instructor demonstrably installed into. See exchangeInstallCode().
  if (!code) {
    scope.setTag("error_type", "missing_code");
    return fail(
      "Discord did not return an authorization for this installation. Try again from the course settings page."
    );
  }

  const exchange = await exchangeInstallCode(code, request);
  if (exchange.outcome === "rejected") {
    scope.setTag("error_type", "code_rejected");
    return fail(
      `Discord would not confirm this installation (${exchange.detail}). Installation links can only be used once — start again from the course settings page.`
    );
  }
  if (exchange.outcome === "unavailable") {
    scope.setTag("error_type", "code_exchange_unavailable");
    Sentry.captureMessage(`Discord install code exchange failed: ${exchange.detail}`, { level: "warning" });
    return fail(
      "Discord could not be reached to confirm the installation, so nothing was recorded. The bot may well have been added — reload this page in a moment to check before trying again."
    );
  }

  const authorizedGuildId = exchange.guildId;
  scope.setTag("discord_guild_id", authorizedGuildId);

  // A mismatch is not fatal -- the exchange wins either way -- but it means someone edited the
  // redirect, so it is worth recording rather than silently discarding.
  if (guildId && guildId !== authorizedGuildId) {
    scope.setTag("error_type", "guild_id_mismatch");
    Sentry.captureMessage(
      `Discord install callback guild_id (${guildId}) did not match the authorized guild (${authorizedGuildId}); using the authorized one`,
      { level: "warning" }
    );
  }

  const lookup = await lookupGuildAsBot(authorizedGuildId);
  if (lookup.outcome === "absent") {
    scope.setTag("error_type", "bot_not_in_guild");
    return fail(
      "Pawtograder cannot see that Discord server, so nothing was connected. Make sure you completed the “Authorize” step and that the bot was actually added to the server."
    );
  }
  if (lookup.outcome === "unavailable") {
    // Explicitly not treated as "the bot was not added". Writing a guild we could not reach would be
    // the same unproven claim the old free-text field made, and telling the instructor the install
    // failed would send them to redo one that may well have worked.
    scope.setTag("error_type", "discord_unavailable");
    Sentry.captureMessage(`Discord install callback could not verify guild membership: ${lookup.detail}`, {
      level: "warning"
    });
    return fail(
      "Discord could not be reached to confirm the installation, so nothing was recorded. The bot may well have been added — reload this page in a moment to check before trying again."
    );
  }

  // ---------------------------------------------------------------------------
  // 4. The claim
  // ---------------------------------------------------------------------------

  // Admin client: claim_discord_guild() is granted to service_role only, because it is the sole
  // writer of classes.discord_server_id and instructors must not be able to reach it directly. The
  // claiming user is passed explicitly -- a service-role call carries no auth.uid() -- and the
  // function re-checks that they are staff of the class.
  //
  // Type-erased for the same reason as lib/metrics.ts: the RPC lands with migration
  // 20260822130000_discord_guild_claim.sql, and SupabaseTypes.d.ts is regenerated centrally once all
  // of this branch's migrations are in, so the name is not in the typed union yet. Runtime behaviour
  // is identical to a typed call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = (await admin.rpc("claim_discord_guild", {
    p_class_id: classId,
    p_guild_id: authorizedGuildId,
    p_claimed_by: user.id
  })) as { data: ClaimRow[] | null; error: { message: string; code?: string } | null };

  if (error) {
    // The sentinel the migration raises, so the one case an instructor can act on gets its own
    // sentence instead of a generic failure. Matched on the message prefix rather than the SQLSTATE:
    // 23505 also covers the unique index firing on a race, which the function translates to the same
    // prefix, and a bare "duplicate key value violates unique constraint ..." is not something to
    // show anybody.
    if (error.message.includes("DISCORD_GUILD_ALREADY_CLAIMED")) {
      scope.setTag("error_type", "guild_already_claimed");
      const detail = error.message.split("DISCORD_GUILD_ALREADY_CLAIMED:")[1]?.trim();
      return fail(
        detail
          ? `That Discord server is already connected to another course. ${detail}`
          : "That Discord server is already connected to another course."
      );
    }
    if (error.message.includes("DISCORD_CLAIM_FORBIDDEN")) {
      scope.setTag("error_type", "claim_forbidden");
      return fail("You must be an instructor of this course to connect a Discord server.");
    }
    if (error.message.includes("DISCORD_CLAIM_INVALID")) {
      scope.setTag("error_type", "claim_invalid");
      return fail("Discord reported a server id Pawtograder cannot use. Nothing was connected.");
    }
    scope.setTag("error_type", "claim_failed");
    Sentry.captureException(new Error(`claim_discord_guild failed: ${error.message}`), scope);
    // Deliberately not `error.message`. Anything reaching here is an unrecognised Postgres error,
    // whose text names functions, constraints and columns, and this string is rendered on the
    // settings page *and* left in the URL -- so it also lands in browser history and any referrer
    // log. The detail is in Sentry above, which is where it is useful.
    return fail("The Discord server could not be connected. The error has been reported.");
  }

  const claim = data?.[0];
  const moved = !!claim?.previous_guild_id && claim.previous_guild_id !== authorizedGuildId;
  // eslint-disable-next-line no-console
  console.log(
    `[discord install] class ${classId} claimed guild ${authorizedGuildId} (${lookup.name ?? exchange.guildName ?? "unnamed"}) by ${user.id}${
      moved ? `, replacing ${claim?.previous_guild_id}` : ""
    }`
  );

  return clearNonce(
    NextResponse.redirect(manageDiscordPageUrl(request, classId, { installed: moved ? "moved" : "1" }), { status: 302 })
  );
}
