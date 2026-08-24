/**
 * The Discord REST base URL, for the Next.js half of the Discord integration.
 *
 * Mirror of `supabase/functions/_shared/DiscordApiBase.ts`, which cannot be imported here: its
 * resolver reads `Deno.env`, and pulling it into the Next.js TypeScript program is a compile error
 * (`Cannot find name 'Deno'`). Only the default URL is duplicated, and it must stay identical to the
 * Deno file's `DISCORD_API_BASE_DEFAULT` -- the two halves of the same install flow talking to
 * different Discord hosts is precisely the failure the mock seam exists to make impossible.
 *
 * Nothing else about Discord is mirrored. The permission bits and the install URL come straight from
 * `@/supabase/functions/_shared/DiscordPermissions`, which is Deno-free by design and imports
 * cleanly; see the comment on that module.
 */

/** Keep in step with DISCORD_API_BASE_DEFAULT in supabase/functions/_shared/DiscordApiBase.ts. */
export const DISCORD_API_BASE_DEFAULT = "https://discord.com/api/v10";

/**
 * Resolve the Discord API base URL, honouring the `DISCORD_API_BASE_URL` mock override.
 *
 * Read on every call rather than captured at module load, so a restarted local mock is picked up
 * without restarting the server. Returned without a trailing slash so callers can concatenate
 * endpoints that begin with `/`.
 */
export function discordApiBase(): string {
  const override = process.env.DISCORD_API_BASE_URL;
  if (!override) return DISCORD_API_BASE_DEFAULT;
  const trimmed = override.trim();
  if (trimmed === "") return DISCORD_API_BASE_DEFAULT;
  return trimmed.replace(/\/+$/, "");
}
