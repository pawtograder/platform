/**
 * Read-only Discord REST calls made as the bot, for the installation-check functions.
 *
 * Separate from DiscordWrapper because the wrapper's contract is wrong for a health check: it throws
 * on every non-2xx, so the caller can only recover the status and the Discord error code by
 * re-parsing its message. A check function's whole job is to tell "the bot is not in this guild"
 * (404 / 10004, a fact to report) apart from "Discord did not answer" (5xx, a failure to raise), so
 * it needs the status as a value rather than as text inside an exception.
 *
 * These are unauthenticated-by-guild GETs with no side effects, so they also skip the wrapper's
 * Bottleneck limiters: a check is one interactive request triggered by one instructor clicking one
 * button, not queue-driven fan-out.
 */
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { discordApiBase } from "./DiscordApiBase.ts";
import { UserVisibleError } from "./HandlerUtils.ts";

/**
 * Deadline for a single check request.
 *
 * Shorter than DiscordWrapper's 15s: this runs while an instructor watches a spinner, and three
 * chained calls at 15s each would outlive most clients' patience and some proxies' own timeouts.
 */
export const DISCORD_BOT_GET_TIMEOUT_MS = 8_000;

export type DiscordBotGetResult = {
  status: number;
  ok: boolean;
  /** Parsed JSON body on success, `null` when the body was absent or unparseable. */
  data: unknown;
  /** Discord's JSON error code from a failure body, when it carried one. */
  code?: number;
  /** Raw failure body, truncated, for logs and Sentry context. */
  detail: string;
};

/** The bot token, or a 500 that names the missing configuration rather than a bare fetch failure. */
export function getBotToken(): string {
  const token = Deno.env.get("DISCORD_BOT_TOKEN");
  if (!token) {
    throw new UserVisibleError("Discord is not configured on this deployment (DISCORD_BOT_TOKEN is unset)", 500);
  }
  return token;
}

/**
 * GET a Discord endpoint as the bot, returning the status instead of throwing on it.
 *
 * Throws only for the cases where no answer was received at all -- a timeout or a transport failure
 * -- and throws them as a retryable 503, because reporting "the bot is not installed" on the
 * strength of a dropped connection is the specific wrong answer this module is shaped to avoid.
 *
 * `path` starts with `/` and is appended to `discordApiBase()`, so a mocked deployment is followed
 * automatically.
 */
export async function discordBotGet(path: string, scope?: Sentry.Scope): Promise<DiscordBotGetResult> {
  const token = getBotToken();
  const url = `${discordApiBase()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCORD_BOT_GET_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": "Pawtograder-Discord-Bot/1.0"
      },
      signal: controller.signal
    });
  } catch (fetchError) {
    if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
      scope?.setContext("discord_timeout", { path, timeout_ms: DISCORD_BOT_GET_TIMEOUT_MS });
      throw new UserVisibleError(`Discord did not respond within ${DISCORD_BOT_GET_TIMEOUT_MS}ms. Try again.`, 503);
    }
    scope?.setContext("discord_transport_error", { path, error: String(fetchError) });
    throw new UserVisibleError(`Could not reach Discord: ${String(fetchError)}`, 503);
  } finally {
    clearTimeout(timer);
  }

  // Always drain the body. An unread body holds its connection out of the pool and makes Deno warn,
  // and on the failure paths the body is the only place the Discord error code appears.
  const text = await response.text().catch(() => "");
  if (response.ok) {
    let data: unknown = null;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      // A 2xx with an unparseable body is not something a caller can act on; let it read as absent
      // and the caller's own field checks will report it.
      data = null;
    }
    return { status: response.status, ok: true, data, detail: "" };
  }

  let code: number | undefined;
  try {
    const parsed = JSON.parse(text) as { code?: number };
    code = typeof parsed?.code === "number" ? parsed.code : undefined;
  } catch {
    code = undefined;
  }
  return { status: response.status, ok: false, data: null, code, detail: text.slice(0, 500) };
}

/**
 * The bot's own user id, which `GET /guilds/{guild.id}/members/{user.id}` needs spelled out.
 *
 * `@me` is not usable there. Discord accepts it only on the PATCH (Modify Current Member); the GET
 * parses the last segment as a snowflake and answers 400 / 50035 `Value "@me" is not snowflake.`
 * for anything else. There is a documented "Get Current User Guild Member"
 * (`GET /users/@me/guilds/{guild.id}/member`), but it is an OAuth2 route requiring the
 * `guilds.members.read` scope and is not available to a bot token, so the id has to be resolved.
 *
 * Read from `/users/@me` rather than assumed from `DISCORD_APPLICATION_ID`. The two are equal for a
 * bot application, but that is an invariant about Discord rather than about this deployment's
 * configuration, and a wrong or absent env var would resurface as the same opaque "could not report
 * the bot's guild membership" this function exists to prevent. Asking Discord cannot be misconfigured.
 *
 * Memoized for the isolate: a deployment's bot identity does not change, so this costs one extra
 * request per warm isolate rather than one per check.
 *
 * Failures come back as the raw result instead of throwing, so callers classify a bad answer here
 * with exactly the same rules they apply to every other Discord answer.
 */
let cachedBotUserId: string | null = null;

export async function getBotUserId(
  scope?: Sentry.Scope
): Promise<{ ok: true; id: string } | { ok: false; result: DiscordBotGetResult }> {
  if (cachedBotUserId) return { ok: true, id: cachedBotUserId };
  const result = await discordBotGet("/users/@me", scope);
  if (!result.ok) return { ok: false, result };
  const id = (result.data as { id?: string } | null)?.id;
  if (!id) {
    // A 2xx that does not carry an id is not something the caller can act on, and is not transient.
    // Reported as a 502-shaped result so it lands in the caller's terminal branch rather than
    // becoming a "try again" that never succeeds.
    return { ok: false, result: { ...result, ok: false, status: 502, detail: "GET /users/@me returned no id" } };
  }
  cachedBotUserId = id;
  return { ok: true, id };
}

/**
 * True when a failed response says nothing about the guild's configuration, only that Discord is
 * unwell or rate-limiting us -- a 5xx or a 429.
 *
 * Callers turn these into a thrown error. Everything else is a fact about the guild that the check
 * is supposed to report.
 *
 * 401 is deliberately NOT here. It is not transient in any useful sense: it means the platform's bot
 * token is wrong, and every subsequent call will answer the same way until somebody rotates a secret.
 * Grouping it with the 5xxs made the instructor-facing check say "Discord could not be reached ... Try
 * again", under a heading that disclaims saying anything about the installation -- so a deployment-wide
 * credential failure was indistinguishable from a blip, on every instructor's settings page, forever.
 * `isDiscordCredentialFailure` is the branch for it.
 */
export function isTransientDiscordStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * True when Discord rejected our own credentials rather than answering about the guild.
 *
 * Separated from the transient statuses because the remediation has nothing to do with the class: no
 * amount of retrying, re-authorizing, or editing channel permissions changes it. The only fix is on
 * the platform side, so the message has to say so and the event has to reach whoever holds the secret.
 */
export function isDiscordCredentialFailure(status: number): boolean {
  return status === 401;
}
