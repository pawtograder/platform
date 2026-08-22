/**
 * Shared bits of the Discord bot install round-trip: where to send the browser, and what to tell it.
 *
 * Used by `app/api/discord/install` and `app/api/discord/install/callback`. The signed `state` those
 * two exchange lives in `lib/discordInstallState.ts`.
 */
import "server-only";
import { discordApiBase } from "@/lib/discordApiBase";

/**
 * The origin to build absolute redirects from.
 *
 * Taken from configuration, never from request headers. An earlier version of this preferred
 * `X-Forwarded-Host` and forced https, on the reasoning that behind a load balancer the request's own
 * origin is the internal one. That is true, but the header is caller-supplied: sending
 * `X-Forwarded-Host: evil.example.com` moved every redirect this module builds onto that host, so the
 * unauthenticated branch of `app/api/discord/install` became an open redirect
 * (`https://evil.example.com/sign-in?redirect=...`). Whether an edge proxy happens to overwrite the
 * header is not a property this module should depend on.
 *
 * `NEXT_PUBLIC_PAWTOGRADER_WEB_URL` is already the canonical public origin elsewhere in the app (see
 * `app/actions.ts`), with `VERCEL_PROJECT_PRODUCTION_URL` preferred on Vercel preview/production. It
 * also has to be the origin here for a second reason: `installCallbackUrl` below has to match a
 * redirect URI registered on the Discord application exactly, and a value derived from an inbound
 * header cannot be registered in advance.
 *
 * Falling back to the request's own origin keeps a misconfigured deployment working rather than
 * redirecting to `undefined/...`, and is safe because it is this server's real origin.
 */
export function redirectOrigin(request: Request): string {
  const configured = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL;
  if (configured) {
    try {
      // Normalised through URL so a trailing slash or a stray path in the env var cannot produce a
      // double-slashed redirect.
      return new URL(configured).origin;
    } catch {
      // Fall through to the request origin below rather than throwing inside a redirect builder.
    }
  }
  return new URL(request.url).origin;
}

/**
 * The `redirect_uri` handed to Discord, and the route Discord returns the browser to.
 *
 * Must match one of the redirects registered on the Discord application, or the consent screen
 * refuses the request outright with "Invalid OAuth2 redirect_uri".
 */
export function installCallbackUrl(request: Request): string {
  return `${redirectOrigin(request)}/api/discord/install/callback`;
}

/**
 * The course's Discord settings page, with a result to render.
 *
 * `app/auth/callback/route.ts` has to sanitise a caller-supplied `next` against protocol-relative and
 * backslash tricks because it forwards wherever it was told to go. This flow accepts no destination
 * parameter at all: the only place it can land is the settings page of the class in the *signed*
 * state, and the path is built from an integer. There is nothing for an open redirect to work on, so
 * the safe thing here is to keep it that way rather than to add a sanitiser.
 *
 * `error_description` is the same param the rest of the app already surfaces (the GitHub link banner,
 * `/api/discord/oauth/callback`), so the message renders without new plumbing.
 */
export function manageDiscordPageUrl(
  request: Request,
  classId: number,
  result: { error?: string; errorDescription?: string; installed?: string; disconnected?: string }
): string {
  const url = new URL(`${redirectOrigin(request)}/course/${classId}/manage/discord`);
  if (result.error) url.searchParams.set("error", result.error);
  if (result.errorDescription) url.searchParams.set("error_description", result.errorDescription);
  if (result.installed) url.searchParams.set("discord_installed", result.installed);
  if (result.disconnected) url.searchParams.set("discord_disconnected", result.disconnected);
  return url.toString();
}

/** How long to wait on Discord before giving up on the install confirmation. */
const GUILD_FETCH_TIMEOUT_MS = 10_000;

export type CodeExchange =
  /**
   * Discord accepted the authorization code. `guildId` is the guild the consent screen actually
   * installed the bot into, as reported by Discord itself.
   */
  | { outcome: "ok"; guildId: string; guildName: string | null; scope: string }
  /** Discord rejected the code: already redeemed, expired, or minted for a different client. */
  | { outcome: "rejected"; detail: string }
  /** The exchange could not be completed, so it says nothing either way. */
  | { outcome: "unavailable"; detail: string };

/**
 * Redeem the OAuth authorization code from the install callback, and take the guild from the result.
 *
 * This is what makes the guild trustworthy, and it is not interchangeable with asking the bot token
 * whether it can see a guild. `lookupGuildAsBot` proves only that the shared bot is *present*
 * somewhere -- and one bot serves every course on the deployment, so "present" is true of every
 * guild any course ever connected. An instructor can legitimately start an install (they are staff
 * on their own class, so the state and nonce are theirs), then abandon Discord's consent screen and
 * hand-craft a callback URL naming a different guild the bot already happens to be in. The unique
 * index stops that when an unarchived class holds the guild, but a guild belonging to an archived
 * course -- or one the bot joined for any other reason -- would be claimable, and Pawtograder would
 * start creating roles and channels in a server whose administrators never agreed to it.
 *
 * The authorization code closes that: it is issued by Discord to the *browser that completed the
 * consent screen*, is single-use, and the token response names the guild the bot was actually added
 * to. A caller cannot mint one for a guild they did not just authorize.
 *
 * The bot-token lookup is still worth doing afterwards, for the different question it answers: that
 * the bot is present *now*, rather than having been added and immediately kicked.
 */
export async function exchangeInstallCode(code: string, request: Request): Promise<CodeExchange> {
  // The application id doubles as the OAuth client id for a Discord app, but the secret is its own
  // credential and is not interchangeable with the bot token.
  const clientId = process.env.DISCORD_OAUTH_CLIENT_ID ?? process.env.DISCORD_APPLICATION_ID;
  const clientSecret = process.env.DISCORD_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {
      outcome: "unavailable",
      detail: "DISCORD_OAUTH_CLIENT_ID / DISCORD_OAUTH_CLIENT_SECRET are not configured on this deployment"
    };
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    // Discord requires this to match the redirect_uri the code was issued for, byte for byte. Both
    // sides build it from installCallbackUrl(), which is why that has to be configuration-derived
    // rather than header-derived.
    redirect_uri: installCallbackUrl(request)
  });

  let response: Response;
  try {
    response = await fetch(`${discordApiBase()}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Pawtograder (install-callback)" },
      body,
      signal: AbortSignal.timeout(GUILD_FETCH_TIMEOUT_MS),
      cache: "no-store"
    });
  } catch (e) {
    return { outcome: "unavailable", detail: e instanceof Error ? e.message : "network error" };
  }

  const parsed = (await response.json().catch(() => null)) as {
    guild?: { id?: unknown; name?: unknown } | null;
    scope?: unknown;
    error?: unknown;
    error_description?: unknown;
  } | null;

  if (!response.ok) {
    // 400 invalid_grant is the ordinary case: a replayed or expired code. Treated as a rejection
    // rather than an outage, because retrying it cannot help.
    if (response.status === 400 || response.status === 401) {
      const detail = typeof parsed?.error === "string" ? parsed.error : `HTTP ${response.status}`;
      return { outcome: "rejected", detail };
    }
    return { outcome: "unavailable", detail: `Discord answered HTTP ${response.status}` };
  }

  // A `bot` grant carries the guild it was installed into. Its absence means this code was not a bot
  // install -- so there is no guild to claim, and falling back to the query parameter is exactly the
  // trust this function exists to remove.
  const guildId = parsed?.guild?.id;
  if (typeof guildId !== "string" || !/^\d{17,20}$/.test(guildId)) {
    return { outcome: "rejected", detail: "the authorization did not include a Discord server" };
  }

  return {
    outcome: "ok",
    guildId,
    guildName: typeof parsed?.guild?.name === "string" ? parsed.guild.name : null,
    scope: typeof parsed?.scope === "string" ? parsed.scope : ""
  };
}

export type GuildLookup =
  /** The bot can see the guild. `name` is whatever Discord reports, which may be absent. */
  | { outcome: "visible"; name: string | null }
  /** Discord answered, and the answer is that the bot is not in this guild. */
  | { outcome: "absent"; status: number }
  /** Discord could not be reached, or answered something that says nothing about membership. */
  | { outcome: "unavailable"; detail: string };

/**
 * Ask Discord, with the bot token, whether the bot is in `guildId`.
 *
 * This is the step that makes the whole flow worth having. Discord's callback tells us which guild
 * the instructor chose, but not that the add succeeded, and the parameters are in a URL the
 * instructor's browser can be handed by anyone. `GET /guilds/{id}` with the bot's own credentials is
 * the only answer that cannot be forged from outside: a guild the bot is not in returns 404 / 10004
 * regardless of what the redirect claimed.
 *
 * "unavailable" is kept apart from "absent" on purpose. Writing a guild we merely failed to reach
 * would be exactly the unproven claim this replaces, and reporting a Discord outage as "the bot was
 * not added" sends the instructor to re-run an install that already worked.
 */
export async function lookupGuildAsBot(guildId: string): Promise<GuildLookup> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    return { outcome: "unavailable", detail: "DISCORD_BOT_TOKEN is not configured on this deployment" };
  }

  let response: Response;
  try {
    response = await fetch(`${discordApiBase()}/guilds/${encodeURIComponent(guildId)}`, {
      headers: { Authorization: `Bot ${token}`, "User-Agent": "Pawtograder (install-callback)" },
      signal: AbortSignal.timeout(GUILD_FETCH_TIMEOUT_MS),
      cache: "no-store"
    });
  } catch (e) {
    return { outcome: "unavailable", detail: e instanceof Error ? e.message : "network error" };
  }

  if (response.ok) {
    const body = (await response.json().catch(() => null)) as { name?: unknown } | null;
    return { outcome: "visible", name: typeof body?.name === "string" ? body.name : null };
  }

  // 10004 Unknown Guild is the same statement as a 404 and Discord sometimes sends it with a
  // different status, so the JSON code is read rather than only the status. 403 / 50001 Missing
  // Access is folded in too: a guild the bot cannot see is one it cannot work in, and re-running the
  // install is the fix for both.
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "number" ? body.code : null;
  if (response.status === 404 || response.status === 403 || code === 10004 || code === 50001) {
    return { outcome: "absent", status: response.status };
  }
  return { outcome: "unavailable", detail: `Discord answered HTTP ${response.status}` };
}
