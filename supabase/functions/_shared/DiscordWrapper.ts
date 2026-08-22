import Bottleneck from "https://esm.sh/bottleneck?target=deno";
import { bottleneckRedisOptions } from "./Redis.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import type {
  SendMessageArgs,
  UpdateMessageArgs,
  CreateChannelArgs,
  DeleteChannelArgs,
  CreateRoleArgs,
  DeleteRoleArgs,
  AddMemberRoleArgs,
  RemoveMemberRoleArgs
} from "./DiscordAsyncTypes.ts";
import { discordApiBase } from "./DiscordApiBase.ts";
import { isBotPermissionProblem, isRateLimitError } from "./DiscordErrorClassification.ts";
import {
  ALL_CHANNELS_REFUSED_INVITE,
  describeCandidate,
  inviteCandidateChannels,
  MAX_INVITE_CHANNEL_ATTEMPTS,
  NO_TEXT_CHANNEL_MESSAGE
} from "./DiscordInviteChannels.ts";

// Discord rate limits:
// - Global: 50 requests per second
// - Per-channel messages: 5 requests per 5 seconds per channel
// - Per-route limits vary

/** Default timeout for Discord API fetch calls (15 seconds) */
const DISCORD_FETCH_TIMEOUT_MS = 15_000;

const globalLimiters = new Map<string, Bottleneck>();
const channelLimiters = new Map<string, Bottleneck>();

/**
 * Get or create a global rate limiter for Discord API
 */
function getGlobalLimiter(): Bottleneck {
  const key = "discord_global";
  const existing = globalLimiters.get(key);
  if (existing) return existing;

  // bottleneckRedisOptions picks ioredis (REDIS_URL) or the Upstash
  // adapter (UPSTASH_REDIS_REST_URL+TOKEN) automatically, or returns
  // null when neither is configured (local-only fallback below).
  const redisOpts = bottleneckRedisOptions();
  let limiter: Bottleneck;
  if (redisOpts) {
    limiter = new Bottleneck({
      id: `discord_global`,
      reservoir: 50,
      reservoirRefreshAmount: 50,
      reservoirRefreshInterval: 1000, // 1 second
      maxConcurrent: 50,
      timeout: 600000, // 10 minutes
      clearDatastore: false,
      ...redisOpts
    });
    limiter.on("error", (err: Error) => console.error(err));
  } else {
    console.log("No Redis configured (REDIS_URL / UPSTASH_*), using local Discord limiter");
    Sentry.captureMessage("No Redis configured, using local Discord limiter");
    limiter = new Bottleneck({
      id: `discord_global:${Deno.env.get("DISCORD_BOT_TOKEN") || ""}`,
      reservoir: 50,
      maxConcurrent: 50,
      reservoirRefreshAmount: 50,
      reservoirRefreshInterval: 1000 // 1 second
    });
  }
  globalLimiters.set(key, limiter);
  return limiter;
}

/**
 * Get or create a per-channel rate limiter for message operations
 * Limits: 5 requests per 5 seconds per channel
 */
function getChannelLimiter(channelId: string): Bottleneck {
  const existing = channelLimiters.get(channelId);
  if (existing) return existing;

  const redisOpts = bottleneckRedisOptions();
  let limiter: Bottleneck;
  if (redisOpts) {
    limiter = new Bottleneck({
      id: `discord_channel:${channelId}`,
      reservoir: 5,
      reservoirRefreshAmount: 5,
      reservoirRefreshInterval: 5000, // 5 seconds
      maxConcurrent: 5,
      timeout: 600000, // 10 minutes
      clearDatastore: false,
      ...redisOpts
    });
    limiter.on("error", (err: Error) => console.error(err));
  } else {
    limiter = new Bottleneck({
      id: `discord_channel:${channelId}:${Deno.env.get("DISCORD_BOT_TOKEN") || ""}`,
      reservoir: 5,
      maxConcurrent: 5,
      reservoirRefreshAmount: 5,
      reservoirRefreshInterval: 5000 // 5 seconds
    });
  }
  channelLimiters.set(channelId, limiter);
  return limiter;
}

/**
 * Get Discord bot token from environment
 */
function getBotToken(): string {
  const token = Deno.env.get("DISCORD_BOT_TOKEN");
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN environment variable is not set");
  }
  return token;
}

/**
 * Make a Discord API request with rate limiting
 */
async function discordRequest(
  method: string,
  endpoint: string,
  body?: unknown,
  scope?: Sentry.Scope
): Promise<Response> {
  const token = getBotToken();
  // Resolved per call rather than at module load: discordApiBase() reads the env override each time
  // so a restarted mock server is picked up without redeploying this isolate.
  const url = `${discordApiBase()}${endpoint}`;

  const globalLimiter = getGlobalLimiter();

  return await globalLimiter.schedule(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Pawtograder-Discord-Bot/1.0"
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (fetchError) {
      clearTimeout(timer);
      // Convert AbortError into a descriptive timeout error
      if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
        const msg = `Discord API timeout after ${DISCORD_FETCH_TIMEOUT_MS}ms: ${method} ${endpoint}`;
        console.error(`[discordRequest] ${msg}`);
        scope?.setContext("discord_timeout", { endpoint, method, timeout_ms: DISCORD_FETCH_TIMEOUT_MS });
        Sentry.addBreadcrumb({ message: msg, level: "error" });
        throw new Error(msg);
      }
      throw fetchError;
    } finally {
      clearTimeout(timer);
    }

    // Check rate limit headers
    const remaining = response.headers.get("X-RateLimit-Remaining");
    const resetAfter = response.headers.get("X-RateLimit-Reset-After");

    if (response.status === 429) {
      // Rate limited
      const retryAfter = resetAfter ? parseFloat(resetAfter) * 1000 : 1000; // Convert to ms
      scope?.setContext("discord_rate_limit", {
        endpoint,
        retry_after_ms: retryAfter,
        remaining: remaining
      });
      Sentry.addBreadcrumb({
        message: `Discord rate limit hit: ${endpoint}`,
        level: "warning",
        data: { retry_after_ms: retryAfter, remaining }
      });
      throw new Error(`Discord rate limit: retry after ${retryAfter}ms`);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      scope?.setContext("discord_api_error", {
        endpoint,
        status: response.status,
        status_text: response.statusText,
        error: errorText
      });
      throw new Error(`Discord API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return response;
  });
}

/**
 * Send a message to a Discord channel
 */
export async function sendMessage(
  args: SendMessageArgs,
  scope?: Sentry.Scope
): Promise<{ id: string; channel_id: string }> {
  const channelLimiter = getChannelLimiter(args.channel_id);

  return await channelLimiter.schedule(async () => {
    const response = await discordRequest(
      "POST",
      `/channels/${args.channel_id}/messages`,
      {
        content: args.content,
        embeds: args.embeds,
        allowed_mentions: args.allowed_mentions
      },
      scope
    );

    const data = await response.json();
    return {
      id: data.id,
      channel_id: data.channel_id
    };
  });
}

/**
 * Update a Discord message
 */
export async function updateMessage(
  args: UpdateMessageArgs,
  scope?: Sentry.Scope
): Promise<{ id: string; channel_id: string }> {
  const channelLimiter = getChannelLimiter(args.channel_id);

  return await channelLimiter.schedule(async () => {
    const response = await discordRequest(
      "PATCH",
      `/channels/${args.channel_id}/messages/${args.message_id}`,
      {
        content: args.content,
        embeds: args.embeds,
        allowed_mentions: args.allowed_mentions
      },
      scope
    );

    const data = await response.json();
    return {
      id: data.id,
      channel_id: data.channel_id
    };
  });
}

/**
 * Create a Discord channel
 */
export async function createChannel(
  args: CreateChannelArgs,
  scope?: Sentry.Scope
): Promise<{ id: string; name: string }> {
  const response = await discordRequest(
    "POST",
    `/guilds/${args.guild_id}/channels`,
    {
      name: args.name,
      type: args.type,
      parent_id: args.parent_id,
      topic: args.topic,
      position: args.position
    },
    scope
  );

  const data = await response.json();
  return {
    id: data.id,
    name: data.name
  };
}

/**
 * Delete a Discord channel
 */
export async function deleteChannel(args: DeleteChannelArgs, scope?: Sentry.Scope): Promise<void> {
  await discordRequest("DELETE", `/channels/${args.channel_id}`, undefined, scope);
}

/**
 * Create a Discord role
 */
export async function createRole(args: CreateRoleArgs, scope?: Sentry.Scope): Promise<{ id: string; name: string }> {
  const response = await discordRequest(
    "POST",
    `/guilds/${args.guild_id}/roles`,
    {
      name: args.name,
      color: args.color,
      hoist: args.hoist,
      mentionable: args.mentionable,
      permissions: args.permissions
    },
    scope
  );

  const data = await response.json();
  return {
    id: data.id,
    name: data.name
  };
}

/**
 * Delete a Discord role
 */
export async function deleteRole(args: DeleteRoleArgs, scope?: Sentry.Scope): Promise<void> {
  await discordRequest("DELETE", `/guilds/${args.guild_id}/roles/${args.role_id}`, undefined, scope);
}

/**
 * Add a role to a guild member
 */
export async function addMemberRole(args: AddMemberRoleArgs, scope?: Sentry.Scope): Promise<void> {
  await discordRequest(
    "PUT",
    `/guilds/${args.guild_id}/members/${args.user_id}/roles/${args.role_id}`,
    undefined,
    scope
  );
}

/**
 * Remove a role from a guild member
 */
export async function removeMemberRole(args: RemoveMemberRoleArgs, scope?: Sentry.Scope): Promise<void> {
  await discordRequest(
    "DELETE",
    `/guilds/${args.guild_id}/members/${args.user_id}/roles/${args.role_id}`,
    undefined,
    scope
  );
}

/**
 * Check if a user is a member of a guild
 */
export async function getGuildMember(
  guildId: string,
  userId: string,
  scope?: Sentry.Scope
): Promise<{ user: { id: string; username: string }; roles: string[] } | null> {
  try {
    const response = await discordRequest("GET", `/guilds/${guildId}/members/${userId}`, undefined, scope);

    const data = await response.json();
    return {
      user: {
        id: data.user.id,
        username: data.user.username
      },
      roles: data.roles || []
    };
  } catch (error) {
    // 404 means user is not in guild
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

/**
 * Revoke an invite by its code.
 *
 * The compensating half of createGuildInvite. Every invite is created with `unique: true`, so an
 * invite that could not be stored is unreachable by anyone -- it is in no table and no UI -- while
 * remaining live in the guild for its full seven days. Deleting it is what keeps a failed or
 * superseded creation from accumulating.
 */
export async function deleteInvite(inviteCode: string, scope?: Sentry.Scope): Promise<void> {
  await discordRequest("DELETE", `/invites/${inviteCode}`, undefined, scope);
}

/**
 * Create an invite link for a guild.
 *
 * Tries candidate channels in order rather than betting the class on one. `GET /guilds/{id}/channels`
 * returns only the channels the bot can see, but seeing a channel and being allowed to create an
 * invite in it are separate permissions: a channel-level CREATE_INSTANT_INVITE denial leaves the
 * channel in the listing and answers the POST with 403 / 50013. Taking the first entry therefore made
 * one locked-down channel enough to block enrollment for a whole class, in a server where the channel
 * next to it would have accepted the request. Invites are the only way in on this branch, since
 * add_guild_member needs a guilds.join scope we do not hold.
 *
 * Only a permission refusal moves on to the next candidate. A 429, a 5xx, a timeout or a dropped
 * connection says nothing about the channel, so working through the list would repeat one failure
 * four times and discard the Retry-After that came with it. A 404 / 10003 also propagates: the channel
 * was in the listing moments ago, so it was deleted mid-flight, the next listing will not contain it,
 * and the roster already words that case for instructors.
 */
export async function createGuildInvite(
  guildId: string,
  maxAge: number = 604800, // 7 days default
  maxUses: number = 5,
  scope?: Sentry.Scope
): Promise<{ code: string; url: string }> {
  const channelsResponse = await discordRequest("GET", `/guilds/${guildId}/channels`, undefined, scope);
  const channels = await channelsResponse.json();

  const candidates = inviteCandidateChannels(channels);
  if (candidates.length === 0) {
    // Unchanged wording. The classifier and the instructor-facing roster both match this string, and
    // rows already stored carry it.
    throw new Error(`${NO_TEXT_CHANNEL_MESSAGE} ${guildId} to create invite`);
  }

  const attempts = candidates.slice(0, MAX_INVITE_CHANNEL_ATTEMPTS);
  const refused: string[] = [];
  let lastRefusal: unknown;

  for (const candidate of attempts) {
    try {
      const inviteResponse = await discordRequest(
        "POST",
        `/channels/${candidate.id}/invites`,
        {
          max_age: maxAge,
          max_uses: maxUses,
          unique: true
        },
        scope
      );

      const inviteData = await inviteResponse.json();
      if (refused.length > 0) {
        // Worth a line in the logs even though it succeeded: the guild is one permission change away
        // from having no working candidate at all, and nothing else records that.
        console.log(
          `[createGuildInvite] guild ${guildId}: created invite in ${describeCandidate(candidate)} after ${refused.length} refused ${refused.length === 1 ? "channel" : "channels"} (${refused.join(", ")})`
        );
      }
      return {
        code: inviteData.code,
        url: `https://discord.gg/${inviteData.code}`
      };
    } catch (error) {
      if (isRateLimitError(error) || !isBotPermissionProblem(error)) throw error;
      refused.push(describeCandidate(candidate));
      lastRefusal = error;
    }
  }

  // Distinct from the no-channel message above, because the remediations are opposites: add a text
  // channel, versus grant the bot Create Invite in one that exists. The refusal is appended verbatim
  // so the message still carries the HTTP status and JSON code that classifyDiscordError reads, which
  // is what keeps this terminal rather than retried every hour.
  const lastMessage = lastRefusal instanceof Error ? lastRefusal.message : String(lastRefusal);
  throw new Error(
    `${ALL_CHANNELS_REFUSED_INVITE} in guild ${guildId}: tried ${refused.length} of ${candidates.length} visible ${candidates.length === 1 ? "channel" : "channels"} (${refused.join(", ")}); last error: ${lastMessage}`
  );
}

/**
 * Get Discord user ID from Discord user ID string
 * This is a helper to convert Discord snowflake IDs
 */
export function getDiscordUserId(discordId: string): string {
  return discordId; // Discord IDs are already strings
}
