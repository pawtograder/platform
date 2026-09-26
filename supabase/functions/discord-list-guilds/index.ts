/**
 * Lists the Discord servers the Pawtograder bot has been added to, for the class-creation and
 * class-settings forms. The Discord counterpart of list-github-orgs.
 *
 * ADMIN ONLY, and deliberately so. This is a cross-tenant view: it returns every guild the single
 * shared bot account is in, which is every course's server across the whole deployment. Exposing it
 * to instructors would let any one of them read the names of every other course's Discord server --
 * including servers belonging to classes they have no relationship with -- purely as a side effect of
 * picking their own. Instructors get the per-class check (discord-check-bot-installation) instead,
 * which is scoped to the one guild their class is configured with.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { discordBotGet, isTransientDiscordStatus } from "../_shared/DiscordBotRest.ts";
import { botInstallUrl } from "../_shared/DiscordPermissions.ts";
import type { ListDiscordGuildsResponse } from "../_shared/FunctionTypes.d.ts";
import { UserVisibleError, assertUserIsAdmin, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";

/** Discord's maximum page size for `GET /users/@me/guilds`. */
const GUILD_PAGE_SIZE = 200;

/**
 * Pages to fetch at most.
 *
 * The endpoint is cursor-paginated with no total, so an unbounded loop is a request the bot's own
 * growth can turn into a timeout. 25 pages is 5,000 guilds -- orders of magnitude above any real
 * deployment -- and stopping there truncates a list rather than hanging a form.
 */
const MAX_GUILD_PAGES = 25;

type GuildListEntry = { id?: string; name?: string };

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<ListDiscordGuildsResponse> {
  scope?.setTag("function", "discord-list-guilds");
  await assertUserIsAdmin(req.headers.get("Authorization"));

  const applicationId = Deno.env.get("DISCORD_APPLICATION_ID");
  if (!applicationId) {
    throw new UserVisibleError("Discord is not configured on this deployment (DISCORD_APPLICATION_ID is unset)", 500);
  }

  const guilds: { id: string; name: string }[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_GUILD_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(GUILD_PAGE_SIZE) });
    if (after) query.set("after", after);
    const result = await discordBotGet(`/users/@me/guilds?${query.toString()}`, scope);
    if (!result.ok) {
      const status = isTransientDiscordStatus(result.status) ? 503 : 502;
      throw new UserVisibleError(`Discord could not list the bot's servers (HTTP ${result.status})`, status);
    }
    const batch = Array.isArray(result.data) ? (result.data as GuildListEntry[]) : [];
    for (const guild of batch) {
      if (guild.id) guilds.push({ id: guild.id, name: guild.name ?? "" });
    }
    if (batch.length < GUILD_PAGE_SIZE) break;
    after = batch[batch.length - 1]?.id;
    // No cursor to advance on means the next request would repeat this page forever.
    if (!after) break;
  }

  guilds.sort((a, b) => a.name.localeCompare(b.name));
  return { guilds, installUrl: botInstallUrl({ applicationId }) };
}

Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleRequest);
});
