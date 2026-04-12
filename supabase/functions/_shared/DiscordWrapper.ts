import Bottleneck from "https://esm.sh/bottleneck?target=deno";
import { Redis } from "./Redis.ts";
import * as Sentry from "npm:@sentry/deno";
import type {
  SendMessageArgs,
  UpdateMessageArgs,
  CreateChannelArgs,
  DeleteChannelArgs,
  CreateRoleArgs,
  DeleteRoleArgs,
  AddMemberRoleArgs,
  RemoveMemberRoleArgs,
  AddGuildMemberArgs
} from "./DiscordAsyncTypes.ts";

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

  let limiter: Bottleneck;
  const upstashUrl = Deno.env.get("UPSTASH_REDIS_REST_URL");
  const upstashToken = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

  if (upstashUrl && upstashToken) {
    const host = upstashUrl.replace("https://", "");
    const password = upstashToken;
    limiter = new Bottleneck({
      id: `discord_global`,
      reservoir: 50,
      reservoirRefreshAmount: 50,
      reservoirRefreshInterval: 1000, // 1 second
      maxConcurrent: 50,
      datastore: "ioredis",
      timeout: 600000, // 10 minutes
      clearDatastore: false,
      clientOptions: {
        host,
        password,
        username: "default"
      },
      Redis
    });
    limiter.on("error", (err: Error) => console.error(err));
  } else {
    console.log("No Upstash URL or token found, using local limiter for Discord");
    Sentry.captureMessage("No Upstash URL or token found, using local Discord limiter");
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

  let limiter: Bottleneck;
  const upstashUrl = Deno.env.get("UPSTASH_REDIS_REST_URL");
  const upstashToken = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

  if (upstashUrl && upstashToken) {
    const host = upstashUrl.replace("https://", "");
    const password = upstashToken;
    limiter = new Bottleneck({
      id: `discord_channel:${channelId}`,
      reservoir: 5,
      reservoirRefreshAmount: 5,
      reservoirRefreshInterval: 5000, // 5 seconds
      maxConcurrent: 5,
      datastore: "ioredis",
      timeout: 600000, // 10 minutes
      clearDatastore: false,
      clientOptions: {
        host,
        password,
        username: "default"
      },
      Redis
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
  const url = `https://discord.com/api/v10${endpoint}`;

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
 * Add a user to a guild (requires OAuth access token with guilds.join scope)
 */
export async function addGuildMember(
  args: AddGuildMemberArgs,
  scope?: Sentry.Scope
): Promise<{ user: { id: string; username: string } }> {
  const response = await discordRequest(
    "PUT",
    `/guilds/${args.guild_id}/members/${args.user_id}`,
    {
      access_token: args.access_token,
      nick: args.nick,
      roles: args.roles,
      mute: args.mute,
      deaf: args.deaf
    },
    scope
  );

  const data = await response.json();
  return {
    user: {
      id: data.user?.id || args.user_id,
      username: data.user?.username || ""
    }
  };
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
 * Create an invite link for a guild
 */
export async function createGuildInvite(
  guildId: string,
  maxAge: number = 604800, // 7 days default
  maxUses: number = 5,
  scope?: Sentry.Scope
): Promise<{ code: string; url: string }> {
  // Find a channel to create invite in (prefer text channels)
  const channelsResponse = await discordRequest("GET", `/guilds/${guildId}/channels`, undefined, scope);
  const channels = await channelsResponse.json();

  // Find first text channel (type 0)
  const textChannel = channels.find((ch: { type: number }) => ch.type === 0);
  if (!textChannel) {
    throw new Error(`No text channels found in guild ${guildId} to create invite`);
  }

  const inviteResponse = await discordRequest(
    "POST",
    `/channels/${textChannel.id}/invites`,
    {
      max_age: maxAge,
      max_uses: maxUses,
      unique: true
    },
    scope
  );

  const inviteData = await inviteResponse.json();
  return {
    code: inviteData.code,
    url: `https://discord.gg/${inviteData.code}`
  };
}

/**
 * Get Discord user ID from Discord user ID string
 * This is a helper to convert Discord snowflake IDs
 */
export function getDiscordUserId(discordId: string): string {
  return discordId; // Discord IDs are already strings
}
