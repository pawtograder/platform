/**
 * Which Discord failures are worth retrying.
 *
 * The discord async worker used to requeue every failure and dead-letter it after five attempts.
 * That is right for a rate limit or a timeout and wrong for a permission or existence error, which
 * resolves only when a person acts. Two of those produced 30,332 dead-lettered operations over six
 * months for roughly 30 users who had simply never joined a Discord server:
 *
 *   404 Unknown Member   the user is not in the guild        -> resolves when the *user* joins
 *   403 Missing Access   the bot cannot list guild channels  -> resolves when an *admin* grants it
 *
 * Neither is transient, so retrying is unbounded work with no terminal outcome. Classifying them
 * lets the worker record the outcome once and stop.
 *
 * Kept free of Deno and Sentry imports so it is unit-testable on its own.
 *
 * Run from supabase/functions:  deno test --no-check _shared/DiscordErrorClassification.test.ts
 */

/**
 * Discord JSON error codes that describe a permanent condition.
 *
 * Full list: https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
 * Only codes we can actually reach are listed; anything unlisted falls through to the HTTP-status
 * rule below, which is deliberately conservative.
 */
export const TERMINAL_DISCORD_ERROR_CODES: ReadonlyMap<number, string> = new Map([
  [10003, "unknown channel"],
  [10004, "unknown guild"],
  [10007, "unknown member"],
  [10008, "unknown message"],
  [10011, "unknown role"],
  [10013, "unknown user"],
  [10026, "unknown ban"],
  [50001, "missing access"],
  [50007, "cannot send messages to this user"],
  [50013, "missing permissions"],
  [50035, "invalid form body"]
]);

/** Discord error code for "the bot cannot see this resource", the invite-creation failure. */
export const DISCORD_MISSING_ACCESS = 50001;

export type DiscordErrorClassification = {
  /** True when retrying cannot change the outcome. */
  terminal: boolean;
  /** HTTP status parsed out of the wrapper's error message, when present. */
  httpStatus?: number;
  /** Discord JSON error code parsed out of the response body, when present. */
  code?: number;
  /** Short human-readable cause, for logs and for the reason shown to instructors. */
  reason?: string;
};

// DiscordWrapper formats failures as:
//   Discord API error: 403 Forbidden - {"message": "Missing Access", "code": 50001}
const HTTP_STATUS_PATTERN = /Discord API error:\s*(\d{3})\b/;
const ERROR_CODE_PATTERN = /"code"\s*:\s*(\d+)/;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const maybe = error as { message?: unknown };
  return typeof maybe?.message === "string" ? maybe.message : "";
}

/** Pull the HTTP status and Discord error code out of a wrapper error, when it carries them. */
export function parseDiscordApiError(error: unknown): { httpStatus?: number; code?: number } {
  const message = messageOf(error);

  const statusMatch = message.match(HTTP_STATUS_PATTERN);
  const codeMatch = message.match(ERROR_CODE_PATTERN);

  return {
    httpStatus: statusMatch ? parseInt(statusMatch[1], 10) : undefined,
    code: codeMatch ? parseInt(codeMatch[1], 10) : undefined
  };
}

/**
 * True for a rate limit, which the worker handles with its own backoff rather than as terminal.
 *
 * Anchored on the wrapper's own rate-limit message and on the *parsed* HTTP status, never on a bare
 * "429" substring. Snowflake IDs are 17-19 digits and the wrapper interpolates them into its error
 * messages, so roughly one guild in sixty contains "429" somewhere in its ID -- enough that
 * `No text channels found in guild 1142900000000000000 to create invite` would be classified
 * retriable and retried forever, which is the exact failure mode this module exists to end.
 */
function isRateLimitMessage(message: string, httpStatus: number | undefined): boolean {
  return message.includes("Discord rate limit") || httpStatus === 429;
}

/** True for a rate limit, which the worker handles with its own backoff rather than as terminal. */
export function isRateLimitError(error: unknown): boolean {
  return isRateLimitMessage(messageOf(error), parseDiscordApiError(error).httpStatus);
}

/**
 * Decide whether a Discord failure can ever succeed on a later attempt.
 *
 * Unknown failures are classified retriable. A retriable classification that should have been
 * terminal costs five attempts and a dead-letter row; a terminal classification that should have
 * been retriable silently drops real work.
 */
export function classifyDiscordError(error: unknown): DiscordErrorClassification {
  const message = messageOf(error);
  const { httpStatus, code } = parseDiscordApiError(error);

  if (isRateLimitMessage(message, httpStatus)) {
    return { terminal: false, httpStatus, code, reason: "rate limited" };
  }

  // The wrapper's own timeout, and any network-layer failure, are transient by nature.
  if (message.includes("Discord API timeout")) {
    return { terminal: false, httpStatus, code, reason: "timeout" };
  }

  if (code !== undefined && TERMINAL_DISCORD_ERROR_CODES.has(code)) {
    return { terminal: true, httpStatus, code, reason: TERMINAL_DISCORD_ERROR_CODES.get(code) };
  }

  // A guild the bot can reach but that has no text channel cannot be invited into. Discord returns
  // 200 for the channel listing, so there is no status or code to key on.
  if (message.includes("No text channels found in guild")) {
    return { terminal: true, httpStatus, code, reason: "guild has no text channel to invite into" };
  }

  if (httpStatus === 403) {
    return { terminal: true, httpStatus, code, reason: "forbidden" };
  }

  if (httpStatus === 404) {
    return { terminal: true, httpStatus, code, reason: "not found" };
  }

  return { terminal: false, httpStatus, code };
}

/**
 * True when Discord says the member or user does not exist, which is how "has not joined the server"
 * surfaces on a member lookup.
 */
export function isMemberNotFound(error: unknown): boolean {
  const { httpStatus, code } = parseDiscordApiError(error);
  return code === 10007 || code === 10013 || httpStatus === 404;
}

/**
 * True when Discord says the thing we were about to delete does not exist.
 *
 * For a delete that is the success case, not a failure: somebody removed the channel or role in
 * Discord directly and the request has already achieved what it asked for. Callers use this to go on
 * and drop their local tracking row, which would otherwise be left naming a resource that is gone.
 */
export function isResourceGone(error: unknown): boolean {
  const { httpStatus, code } = parseDiscordApiError(error);
  // Unknown channel, message and role respectively.
  if (code === 10003 || code === 10008 || code === 10011) return true;
  // A 404 with no parsable code is the same statement with less detail. Guarded on the code being
  // absent so a 404 that names some *other* condition is not swallowed.
  return httpStatus === 404 && code === undefined;
}

/**
 * True when the failure is the bot's own configuration rather than anything about the user — the
 * distinction instructors need, because this one needs an admin to fix it.
 */
export function isBotPermissionProblem(error: unknown): boolean {
  const { httpStatus, code } = parseDiscordApiError(error);
  if (code === DISCORD_MISSING_ACCESS || code === 50013) return true;
  if (messageOf(error).includes("No text channels found in guild")) return true;
  return httpStatus === 403;
}
