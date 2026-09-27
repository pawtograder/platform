/**
 * Single source of truth for the Discord REST base URL.
 *
 * Production always talks to discord.com. The override exists so a local or CI
 * deployment can point every Discord call at a mock server without any code in
 * the call sites knowing about it — the same seam `PAWTOGRADER_GITHUB_STUB`
 * provides for GitHub, but expressed as a base URL because Discord calls go out
 * through plain `fetch` rather than an SDK we can swap.
 *
 * Set `DISCORD_API_BASE_URL` to something like `http://127.0.0.1:8788/api/v10`.
 * It is read on every call rather than cached at module load so a long-lived
 * edge isolate picks up a restarted mock without a redeploy.
 */
export const DISCORD_API_BASE_DEFAULT = "https://discord.com/api/v10";

/**
 * Resolve the Discord API base URL, honouring the mock override.
 *
 * Returns the value without a trailing slash so callers can concatenate
 * endpoints that begin with `/`.
 */
export function discordApiBase(): string {
  const override = Deno.env.get("DISCORD_API_BASE_URL");
  if (!override) return DISCORD_API_BASE_DEFAULT;
  const trimmed = override.trim();
  if (trimmed === "") return DISCORD_API_BASE_DEFAULT;
  return trimmed.replace(/\/+$/, "");
}

/**
 * True when Discord traffic is being redirected away from discord.com.
 *
 * Call sites use this to keep destructive-looking operations loud in logs
 * during local validation, and to assert in tests that a run really did go to
 * the mock rather than silently reaching the internet.
 */
export function isDiscordApiMocked(): boolean {
  return discordApiBase() !== DISCORD_API_BASE_DEFAULT;
}
