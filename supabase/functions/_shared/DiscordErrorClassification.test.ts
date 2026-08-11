/**
 * Unit tests for Discord failure classification.
 *
 * The error strings below are the exact shapes DiscordWrapper produces, because the classification
 * parses them rather than a structured error object. If the wrapper's message format changes these
 * tests are what notices.
 *
 * Run from supabase/functions:  deno test --no-check _shared/DiscordErrorClassification.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  classifyDiscordError,
  isBotPermissionProblem,
  isMemberNotFound,
  isRateLimitError,
  parseDiscordApiError
} from "./DiscordErrorClassification.ts";

// The two failures from issue #923, verbatim from the DLQ rows.
const MEMBER_NOT_FOUND = new Error('Discord API error: 404 Not Found - {"message": "Unknown Member", "code": 10007}');
const MISSING_ACCESS = new Error('Discord API error: 403 Forbidden - {"message": "Missing Access", "code": 50001}');

Deno.test("parseDiscordApiError: reads the status and the JSON code out of a wrapper message", () => {
  assertEquals(parseDiscordApiError(MISSING_ACCESS), { httpStatus: 403, code: 50001 });
});

Deno.test("parseDiscordApiError: a message with neither yields neither", () => {
  assertEquals(parseDiscordApiError(new Error("boom")), { httpStatus: undefined, code: undefined });
});

Deno.test("parseDiscordApiError: reads a PostgREST-style plain object, not just an Error", () => {
  assertEquals(parseDiscordApiError({ message: 'Discord API error: 404 Not Found - {"code": 10013}' }), {
    httpStatus: 404,
    code: 10013
  });
});

Deno.test("classifyDiscordError: 404 Unknown Member is terminal - it resolves only when the user joins", () => {
  const result = classifyDiscordError(MEMBER_NOT_FOUND);
  assertEquals(result.terminal, true);
  assertEquals(result.code, 10007);
  assertEquals(result.reason, "unknown member");
});

Deno.test("classifyDiscordError: 403 Missing Access is terminal - it resolves only when an admin acts", () => {
  const result = classifyDiscordError(MISSING_ACCESS);
  assertEquals(result.terminal, true);
  assertEquals(result.code, 50001);
  assertEquals(result.reason, "missing access");
});

Deno.test("classifyDiscordError: a rate limit stays retriable so the backoff path keeps handling it", () => {
  const result = classifyDiscordError(new Error("Discord rate limit: retry after 1500ms"));
  assertEquals(result.terminal, false);
  assertEquals(result.reason, "rate limited");
});

Deno.test("classifyDiscordError: a 429 carrying a terminal-looking code is still a rate limit", () => {
  // Rate limiting is checked before the code table so a body that happens to include one of those
  // codes cannot turn a retriable 429 into a dropped message.
  const result = classifyDiscordError(
    new Error('Discord API error: 429 Too Many Requests - {"message": "Missing Access", "code": 50001}')
  );
  assertEquals(result.terminal, false);
});

Deno.test("classifyDiscordError: a wrapper timeout stays retriable", () => {
  const result = classifyDiscordError(new Error("Discord API timeout after 10000ms: GET /guilds/1/members/2"));
  assertEquals(result.terminal, false);
  assertEquals(result.reason, "timeout");
});

Deno.test("classifyDiscordError: a 500 stays retriable", () => {
  assertEquals(
    classifyDiscordError(new Error("Discord API error: 500 Internal Server Error - upstream")).terminal,
    false
  );
});

Deno.test("classifyDiscordError: a 401 stays retriable - a rotated token should not drop queued work", () => {
  assertEquals(
    classifyDiscordError(new Error('Discord API error: 401 Unauthorized - {"message": "401: Unauthorized"}')).terminal,
    false
  );
});

Deno.test("classifyDiscordError: a guild with no text channel is terminal despite returning 200", () => {
  const result = classifyDiscordError(new Error("No text channels found in guild 123 to create invite"));
  assertEquals(result.terminal, true);
  assertEquals(result.reason, "guild has no text channel to invite into");
});

Deno.test("classifyDiscordError: an unrecognised failure stays retriable", () => {
  // Misclassifying retriable as terminal silently drops work, so unknowns must fall this way.
  assertEquals(classifyDiscordError(new Error("connection reset")).terminal, false);
});

Deno.test("classifyDiscordError: a 403 with no parsable code is still terminal", () => {
  const result = classifyDiscordError(new Error("Discord API error: 403 Forbidden - Unknown error"));
  assertEquals(result.terminal, true);
  assertEquals(result.reason, "forbidden");
});

Deno.test("isMemberNotFound: true for Unknown Member and Unknown User, false for Missing Access", () => {
  assertEquals(isMemberNotFound(MEMBER_NOT_FOUND), true);
  assertEquals(isMemberNotFound(new Error('Discord API error: 404 Not Found - {"code": 10013}')), true);
  assertEquals(isMemberNotFound(MISSING_ACCESS), false);
});

Deno.test("isBotPermissionProblem: separates the admin-action cause from the user-action one", () => {
  assertEquals(isBotPermissionProblem(MISSING_ACCESS), true);
  assertEquals(isBotPermissionProblem(new Error('Discord API error: 403 Forbidden - {"code": 50013}')), true);
  assertEquals(isBotPermissionProblem(new Error("No text channels found in guild 9 to create invite")), true);
  assertEquals(isBotPermissionProblem(MEMBER_NOT_FOUND), false);
});

Deno.test("isRateLimitError: matches the wrapper's rate-limit message", () => {
  assertEquals(isRateLimitError(new Error("Discord rate limit: retry after 200ms")), true);
  assertEquals(isRateLimitError(MISSING_ACCESS), false);
});
