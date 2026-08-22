/**
 * Finish the Discord bot install and record the class's claim on the guild.
 *
 * Discord returns the browser here after the instructor adds the bot, with `guild_id`, `permissions`
 * and the `state` we minted in `app/api/discord/install/route.ts`. None of that is evidence on its
 * own -- the whole query string is attacker-authorable, since it arrives as a plain GET the
 * instructor's browser can be pointed at -- so every step below fails closed and the claim only
 * happens once all four have passed:
 *
 *   1. the state verifies (signature, expiry) and its nonce matches this browser's cookie,
 *   2. the caller is *still* an instructor of the class in the state,
 *   3. the bot token can see `guild_id`, and
 *   4. claim_discord_guild() accepts the pair.
 *
 * Step 2 is not redundant with step 1. The state proves the flow was started for this class by this
 * user; it says nothing about whether that is still true ten minutes later, and an enrollment can be
 * disabled in between.
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
import { lookupGuildAsBot, manageDiscordPageUrl, redirectOrigin } from "@/lib/discordInstall";

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
  const guildId = searchParams.get("guild_id");
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
  // 3. Confirm with the bot token that the bot really is in the guild
  // ---------------------------------------------------------------------------

  // Discord sends guild_id only for a bot install that completed. Its absence usually means the
  // consent screen was finished without adding the bot to a server.
  if (!guildId || !/^\d{17,20}$/.test(guildId)) {
    scope.setTag("error_type", "missing_guild_id");
    return fail(
      "Discord did not report which server the bot was added to. Try again and make sure you pick a server on the authorization screen."
    );
  }
  scope.setTag("discord_guild_id", guildId);

  const lookup = await lookupGuildAsBot(guildId);
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
    p_guild_id: guildId,
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
    return fail(`The Discord server could not be connected: ${error.message}`);
  }

  const claim = data?.[0];
  const moved = !!claim?.previous_guild_id && claim.previous_guild_id !== guildId;
  // eslint-disable-next-line no-console
  console.log(
    `[discord install] class ${classId} claimed guild ${guildId} (${lookup.name ?? "unnamed"}) by ${user.id}${
      moved ? `, replacing ${claim?.previous_guild_id}` : ""
    }`
  );

  return clearNonce(
    NextResponse.redirect(manageDiscordPageUrl(request, classId, { installed: moved ? "moved" : "1" }), { status: 302 })
  );
}
