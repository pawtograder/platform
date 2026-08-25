/**
 * A mock of Discord's REST API, faithful enough that the integration's error handling runs for real.
 *
 * Point a deployment at it with `DISCORD_API_BASE_URL=http://127.0.0.1:8788/api/v10`, which
 * supabase/functions/_shared/DiscordApiBase.ts reads on every call, and every Discord request the
 * edge functions make arrives here instead of discord.com.
 *
 *   npx tsx tests/mocks/discord/server.ts
 *
 * Node standard library only, no dependencies, so it can run beside a local Supabase without any
 * install step. Port comes from DISCORD_MOCK_PORT and defaults to 8788. It binds 127.0.0.1.
 *
 * What makes it worth having over a handful of stubbed fetches:
 *
 *   - Errors are Discord-shaped, `{"message": …, "code": …}` with the matching HTTP status, so
 *     DiscordErrorClassification.ts classifies them the way it classifies production traffic.
 *   - Permissions and role hierarchy are enforced from state rather than scripted, so a 403 / 50013
 *     is produced by the same condition that produces it in a real server.
 *   - Every request is logged with its status, so a test can assert that a role was assigned, or
 *     that nothing reached Discord at all.
 *
 * The control plane lives under /__mock/ and is documented in README.md. Control-plane requests are
 * not written to the call log, so polling it does not pollute what the log is measuring.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename } from "node:path";
import {
  applyPatch,
  botHasChannelPermission,
  botHasPermission,
  botHighestPosition,
  botPermissions,
  defaultState,
  SCENARIO_DESCRIPTIONS,
  SCENARIO_NAMES,
  scenarioState,
  type FaultRule,
  type MockChannel,
  type MockGuild,
  type MockState,
  type PermissionFlag
} from "./state";

const DEFAULT_PORT = 8788;
/** Oldest entries are dropped past this, so a long-running mock cannot grow without bound. */
const MAX_CALL_LOG = 2000;
const MAX_BODY_BYTES = 1_000_000;

export type CallLogEntry = {
  /** Monotonic, starting at 1, reset with the log. */
  id: number;
  method: string;
  /** Path with the `/api/vNN` prefix stripped, e.g. `/guilds/…/members/…/roles/…`. */
  path: string;
  /** Path exactly as received, prefix included. */
  raw_path: string;
  query: Record<string, string>;
  /** Parsed JSON when the request carried it, the raw text when it did not parse, else null. */
  body: unknown;
  status: number;
  /** Discord JSON error code, when the response carried one. */
  code?: number;
  timestamp: string;
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

type GuildLookup = { ok: true; guild: MockGuild } | { ok: false; reply: Reply };

let state: MockState = defaultState();
let calls: CallLogEntry[] = [];
let callCounter = 0;
let snowflakeCounter = 0;
let inviteCounter = 0;
const startedAt = Date.now();

/** Discord's own wording for the codes this mock can return. */
const ERROR_MESSAGES: Record<number, string> = {
  0: "404: Not Found",
  10003: "Unknown Channel",
  10004: "Unknown Guild",
  10006: "Unknown Invite",
  10007: "Unknown Member",
  10008: "Unknown Message",
  10011: "Unknown Role",
  10013: "Unknown User",
  50001: "Missing Access",
  50005: "Cannot edit a message authored by another user",
  50006: "Cannot send an empty message",
  50013: "Missing Permissions",
  50035: "Invalid Form Body",
  50109: "The request body contains invalid JSON."
};

function nextSnowflake(): string {
  snowflakeCounter += 1;
  return (1500000000000000000n + BigInt(snowflakeCounter)).toString();
}

/** Deterministic invite codes, so a test can predict the second invite of a run. */
function nextInviteCode(): string {
  inviteCounter += 1;
  return `mock${inviteCounter.toString(36).padStart(4, "0")}`;
}

function errorReply(status: number, code: number, message?: string, extra?: Record<string, unknown>): Reply {
  return { status, body: { message: message ?? ERROR_MESSAGES[code] ?? "Unknown error", code, ...extra } };
}

function unknownRoute(): Reply {
  return { status: 404, body: { message: "404: Not Found", code: 0 } };
}

function methodNotAllowed(): Reply {
  return { status: 405, body: { message: "405: Method Not Allowed", code: 0 } };
}

/** Discord's 400 for a required field, whose 50035 the classifier treats as terminal. */
function invalidFormBody(field: string): Reply {
  return errorReply(400, 50035, undefined, {
    errors: { [field]: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }] } }
  });
}

// ============================================================================
// State access
// ============================================================================

/**
 * A guild the bot can act in, or the 404 Discord answers when it cannot.
 *
 * A guild absent from state and a guild the bot is not in return the same body, because that is what
 * Discord does: a bot has no way to tell "no such server" from "not your server". The `guild-gone`
 * and `bot-not-in-guild` scenarios differ in state, not in what a caller observes.
 */
function lookupGuild(guildId: string): GuildLookup {
  const guild = state.guilds[guildId];
  if (!guild || !guild.bot_in_guild) return { ok: false, reply: errorReply(404, 10004) };
  return { ok: true, guild };
}

function findChannel(channelId: string): { guild: MockGuild; channel: MockChannel } | null {
  for (const guild of Object.values(state.guilds)) {
    if (!guild.bot_in_guild) continue;
    const channel = guild.channels.find((candidate) => candidate.id === channelId);
    if (channel) return { guild, channel };
  }
  return null;
}

/**
 * The 403 for a permission the bot does not hold.
 *
 * Missing View Channel is reported as `50001 Missing Access` and everything else as
 * `50013 Missing Permissions`, matching Discord: a bot that cannot see a resource is told it has no
 * access, and one that can see it but may not change it is told it lacks permission.
 */
function permissionError(flag: PermissionFlag): Reply {
  return errorReply(403, flag === "VIEW_CHANNEL" ? 50001 : 50013);
}

function requirePermissions(guild: MockGuild, flags: PermissionFlag[]): Reply | null {
  for (const flag of flags) {
    if (!botHasPermission(guild, flag)) return permissionError(flag);
  }
  return null;
}

/**
 * The same check, but for an operation that acts on one channel.
 *
 * Guild-level permissions are necessary and not sufficient: Discord layers per-channel and
 * per-category overwrites on top, so a bot with Send Messages server-wide can be denied it in one
 * channel. Every route that addresses `/channels/{id}/...` goes through this, so that failure is
 * reachable in a test rather than merely describable.
 */
function requireChannelPermissions(guild: MockGuild, channel: MockChannel, flags: PermissionFlag[]): Reply | null {
  for (const flag of flags) {
    if (!botHasChannelPermission(guild, channel, flag, state.bot.id)) return permissionError(flag);
  }
  return null;
}

// ============================================================================
// Fault injection
// ============================================================================

function rateLimitReply(retryAfterSeconds: number): Reply {
  const seconds = retryAfterSeconds.toString();
  return {
    status: 429,
    body: { message: "You are being rate limited.", retry_after: retryAfterSeconds, global: false },
    headers: {
      "Retry-After": seconds,
      // DiscordWrapper computes its backoff from X-RateLimit-Reset-After and the worker's raw fetch
      // reads Retry-After. Both carry the same number so either path sees the same delay.
      "X-RateLimit-Reset-After": seconds,
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Limit": "50",
      "X-RateLimit-Global": "false",
      "X-RateLimit-Scope": "user"
    }
  };
}

function faultMatches(rule: FaultRule, method: string, path: string): boolean {
  if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;
  if (!rule.path) return true;
  try {
    return new RegExp(rule.path).test(path);
  } catch {
    // An unparseable pattern must not match everything: that would turn a typo in a test into a
    // total outage of the mock, which is a confusing way to learn about a typo.
    return false;
  }
}

function faultReply(rule: FaultRule): Reply {
  if (rule.status === 429) return rateLimitReply(rule.retry_after ?? 1);
  const code = rule.code ?? (rule.status === 403 ? 50013 : 0);
  const fallback =
    rule.status === 401
      ? "401: Unauthorized"
      : rule.status >= 500
        ? `${rule.status}: Internal Server Error`
        : ERROR_MESSAGES[code];
  return errorReply(rule.status, code, rule.message ?? fallback);
}

/** First matching fault, consuming one of its `times` if it is counted. */
function takeFault(method: string, path: string): FaultRule | null {
  for (let index = 0; index < state.faults.length; index += 1) {
    const rule = state.faults[index];
    if (!faultMatches(rule, method, path)) continue;
    if (typeof rule.times === "number") {
      if (rule.times <= 0) continue;
      rule.times -= 1;
      if (rule.times <= 0) state.faults.splice(index, 1);
    }
    return rule;
  }
  return null;
}

// ============================================================================
// Discord routes
// ============================================================================

function guildSummary(guild: MockGuild): Record<string, unknown> {
  return {
    id: guild.id,
    name: guild.name,
    icon: null,
    owner: false,
    // Discord serializes permissions as a decimal string, and parsePermissionBits reads 0n from
    // anything else, so a number here would silently look like "no permissions at all".
    permissions: botPermissions(guild).toString(),
    features: []
  };
}

function botMember(guild: MockGuild): Record<string, unknown> {
  return {
    user: { id: state.bot.id, username: state.bot.username, bot: true, discriminator: "0000" },
    roles: [...guild.bot_roles],
    nick: null,
    joined_at: "2026-01-01T00:00:00.000000+00:00",
    deaf: false,
    mute: false
  };
}

function handleGuildRoutes(method: string, segments: string[], body: unknown): Reply {
  const guildId = segments[1];

  if (segments.length === 2) {
    if (method !== "GET") return methodNotAllowed();
    const found = lookupGuild(guildId);
    if (!found.ok) return found.reply;
    return {
      status: 200,
      body: {
        id: found.guild.id,
        name: found.guild.name,
        icon: null,
        owner_id: found.guild.owner_id ?? null,
        roles: found.guild.roles
      }
    };
  }

  if (segments[2] === "roles") return handleRoleRoutes(method, segments, body, guildId);
  if (segments[2] === "channels") return handleGuildChannelRoutes(method, segments, body, guildId);
  if (segments[2] === "members") return handleMemberRoutes(method, segments, body, guildId);
  return unknownRoute();
}

function handleRoleRoutes(method: string, segments: string[], body: unknown, guildId: string): Reply {
  const found = lookupGuild(guildId);
  if (!found.ok) return found.reply;
  const guild = found.guild;

  if (segments.length === 3) {
    if (method === "GET") return { status: 200, body: guild.roles };
    if (method !== "POST") return methodNotAllowed();
    const denied = requirePermissions(guild, ["MANAGE_ROLES"]);
    if (denied) return denied;
    const args = (body ?? {}) as {
      name?: string;
      color?: number;
      hoist?: boolean;
      mentionable?: boolean;
      permissions?: string;
    };
    const role = {
      id: nextSnowflake(),
      name: args.name ?? "new role",
      // Discord creates every role at position 1, immediately above @everyone, whatever else exists.
      // A caller that needs it higher has to move it, and the hierarchy check below is why it cares.
      position: 1,
      permissions: typeof args.permissions === "string" ? args.permissions : "0",
      color: args.color ?? 0,
      hoist: args.hoist ?? false,
      mentionable: args.mentionable ?? false,
      managed: false
    };
    guild.roles.push(role);
    return { status: 200, body: role };
  }

  if (segments.length === 4) {
    if (method !== "DELETE") return methodNotAllowed();
    const roleId = segments[3];
    const index = guild.roles.findIndex((role) => role.id === roleId);
    if (index === -1) return errorReply(404, 10011);
    const denied = requirePermissions(guild, ["MANAGE_ROLES"]);
    if (denied) return denied;
    if (guild.roles[index].position >= botHighestPosition(guild)) return errorReply(403, 50013);
    guild.roles.splice(index, 1);
    for (const member of Object.values(guild.members)) {
      member.roles = member.roles.filter((held) => held !== roleId);
    }
    return { status: 204 };
  }

  return unknownRoute();
}

function handleGuildChannelRoutes(method: string, segments: string[], body: unknown, guildId: string): Reply {
  if (segments.length !== 3) return unknownRoute();
  const found = lookupGuild(guildId);
  if (!found.ok) return found.reply;
  const guild = found.guild;

  if (method === "GET") {
    // The 403 that produced 557 of the 594 dead-letter rows DiscordErrorClassification.ts describes:
    // createGuildInvite lists channels first, and a bot without View Channel never gets that far.
    const denied = requirePermissions(guild, ["VIEW_CHANNEL"]);
    if (denied) return denied;
    // Discord returns only the channels the bot can actually see, so a VIEW_CHANNEL denial on one
    // channel removes it from the listing entirely rather than returning it with a flag. That is what
    // makes "the bot cannot see #general" and "there is no #general" indistinguishable to a caller,
    // and it is why createGuildInvite picking from this list is not sufficient on its own: a channel
    // that survives the filter can still deny CREATE_INSTANT_INVITE.
    const visible = guild.channels.filter((channel) =>
      botHasChannelPermission(guild, channel, "VIEW_CHANNEL", state.bot.id)
    );
    return { status: 200, body: visible };
  }

  if (method !== "POST") return methodNotAllowed();
  const denied = requirePermissions(guild, ["MANAGE_CHANNELS"]);
  if (denied) return denied;
  const args = (body ?? {}) as { name?: string; type?: number; parent_id?: string; topic?: string; position?: number };
  if (!args.name) return invalidFormBody("name");
  const channel: MockChannel = {
    id: nextSnowflake(),
    name: args.name,
    type: typeof args.type === "number" ? args.type : 0,
    guild_id: guild.id,
    parent_id: args.parent_id ?? null,
    topic: args.topic ?? null,
    position: typeof args.position === "number" ? args.position : guild.channels.length
  };
  guild.channels.push(channel);
  return { status: 201, body: channel };
}

function handleMemberRoutes(method: string, segments: string[], body: unknown, guildId: string): Reply {
  const found = lookupGuild(guildId);
  if (!found.ok) return found.reply;
  const guild = found.guild;

  if (segments.length === 3) {
    if (method !== "GET") return methodNotAllowed();
    return { status: 200, body: Object.values(guild.members) };
  }

  const userId = segments[3];

  if (segments.length === 4) {
    if (userId === "@me") {
      // Discord accepts `@me` here only on the PATCH (Modify Current Member). The GET parses this
      // segment as a snowflake and rejects `@me` with 400 / 50035, so answering it with the bot's
      // member object -- which this mock used to do, GET-only -- inverted the real API exactly.
      // discord-check-bot-installation shipped a `GET .../members/@me` that passed every E2E run
      // against this mock and 400'd against discord.com on the first real install.
      //
      // The PATCH stays unimplemented -- nothing here calls it -- so it keeps the 405 the other
      // unhandled methods get rather than gaining a fake success.
      if (method !== "GET") return methodNotAllowed();
      return errorReply(400, 50035, "Invalid Form Body", {
        errors: { user_id: { _errors: [{ code: "NUMBER_TYPE_COERCE", message: 'Value "@me" is not snowflake.' }] } }
      });
    }
    if (method === "GET") {
      // The bot is a member like any other and Discord returns it by its own snowflake, which is how
      // the check function reads its roles now that `@me` is not an option.
      if (userId === state.bot.id) return { status: 200, body: botMember(guild) };
      const member = guild.members[userId];
      if (!member) return errorReply(404, 10007);
      return { status: 200, body: member };
    }
    if (method === "PUT") {
      // Add Guild Member. Discord requires the bot to hold Create Invite for this, and answers 204
      // with an empty body when the user is already in the guild -- which DiscordWrapper's
      // addGuildMember then tries to parse as JSON. Kept faithful so that path is reachable.
      const args = (body ?? {}) as { access_token?: string; nick?: string; roles?: string[] };
      if (!args.access_token) return invalidFormBody("access_token");
      const denied = requirePermissions(guild, ["CREATE_INSTANT_INVITE"]);
      if (denied) return denied;
      if (guild.members[userId]) return { status: 204 };
      guild.members[userId] = {
        user: { id: userId, username: `user-${userId.slice(-4)}` },
        roles: Array.isArray(args.roles) ? [...args.roles] : [],
        nick: args.nick ?? null,
        joined_at: new Date().toISOString()
      };
      return { status: 201, body: guild.members[userId] };
    }
    return methodNotAllowed();
  }

  if (segments.length === 6 && segments[4] === "roles") {
    const roleId = segments[5];
    const role = guild.roles.find((candidate) => candidate.id === roleId);
    if (!role) return errorReply(404, 10011);
    const member = guild.members[userId];
    if (!member) return errorReply(404, 10007);
    const denied = requirePermissions(guild, ["MANAGE_ROLES"]);
    if (denied) return denied;
    // Discord's hierarchy rule, and the reason the branch added a preflight: a role at or above the
    // acting member's highest role cannot be touched, and the refusal is reported as 50013 -- the
    // same code as not holding Manage Roles, which is why it cannot be diagnosed from the error.
    if (role.position >= botHighestPosition(guild)) return errorReply(403, 50013);
    if (method === "PUT") {
      if (!member.roles.includes(roleId)) member.roles.push(roleId);
      return { status: 204 };
    }
    if (method === "DELETE") {
      member.roles = member.roles.filter((held) => held !== roleId);
      return { status: 204 };
    }
    return methodNotAllowed();
  }

  return unknownRoute();
}

function handleChannelRoutes(method: string, segments: string[], body: unknown): Reply {
  const channelId = segments[1];
  const located = findChannel(channelId);

  if (segments.length === 2) {
    if (method === "GET") {
      if (!located) return errorReply(404, 10003);
      return { status: 200, body: located.channel };
    }
    if (method !== "DELETE") return methodNotAllowed();
    if (!located) return errorReply(404, 10003);
    const denied = requireChannelPermissions(located.guild, located.channel, ["MANAGE_CHANNELS"]);
    if (denied) return denied;
    located.guild.channels = located.guild.channels.filter((candidate) => candidate.id !== channelId);
    return { status: 200, body: located.channel };
  }

  if (segments[2] === "messages") {
    if (!located) return errorReply(404, 10003);
    const { guild } = located;

    if (segments.length === 3) {
      if (method !== "POST") return methodNotAllowed();
      const denied = requireChannelPermissions(guild, located.channel, ["VIEW_CHANNEL", "SEND_MESSAGES"]);
      if (denied) return denied;
      const args = (body ?? {}) as { content?: string; embeds?: unknown[] };
      const embeds = Array.isArray(args.embeds) ? args.embeds : [];
      if (!args.content && embeds.length === 0) return errorReply(400, 50006);
      const message = {
        id: nextSnowflake(),
        channel_id: channelId,
        guild_id: guild.id,
        content: args.content ?? "",
        embeds,
        author: { id: state.bot.id, username: state.bot.username, bot: true },
        timestamp: new Date().toISOString(),
        edited_timestamp: null
      };
      state.messages[message.id] = message;
      return { status: 200, body: message };
    }

    if (segments.length === 4) {
      const messageId = segments[3];
      const existing = state.messages[messageId];
      if (!existing || existing.channel_id !== channelId) return errorReply(404, 10008);
      if (method === "GET") return { status: 200, body: existing };
      if (method !== "PATCH") return methodNotAllowed();
      const denied = requireChannelPermissions(guild, located.channel, ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"]);
      if (denied) return denied;
      if (existing.author.id !== state.bot.id) return errorReply(403, 50005);
      const args = (body ?? {}) as { content?: string; embeds?: unknown[] };
      if (typeof args.content === "string") existing.content = args.content;
      if (Array.isArray(args.embeds)) existing.embeds = args.embeds;
      existing.edited_timestamp = new Date().toISOString();
      return { status: 200, body: existing };
    }

    return unknownRoute();
  }

  if (segments[2] === "invites" && segments.length === 3) {
    if (method !== "POST") return methodNotAllowed();
    if (!located) return errorReply(404, 10003);
    const { guild, channel } = located;
    const denied = requireChannelPermissions(guild, located.channel, ["VIEW_CHANNEL", "CREATE_INSTANT_INVITE"]);
    if (denied) return denied;
    const args = (body ?? {}) as { max_age?: number; max_uses?: number };
    const invite = {
      code: nextInviteCode(),
      guild_id: guild.id,
      channel_id: channel.id,
      max_age: args.max_age ?? 604800,
      max_uses: args.max_uses ?? 5,
      uses: 0,
      created_at: new Date().toISOString()
    };
    state.invites[invite.code] = invite;
    return {
      status: 200,
      body: {
        code: invite.code,
        guild: { id: guild.id, name: guild.name },
        channel: { id: channel.id, name: channel.name, type: channel.type },
        inviter: { id: state.bot.id, username: state.bot.username, bot: true },
        max_age: invite.max_age,
        max_uses: invite.max_uses,
        uses: 0,
        temporary: false,
        created_at: invite.created_at
      }
    };
  }

  return unknownRoute();
}

function handleInviteRoutes(method: string, segments: string[]): Reply {
  if (segments.length !== 2) return unknownRoute();
  const code = segments[1];
  const invite = state.invites[code];
  if (method === "GET") {
    if (!invite) return errorReply(404, 10006);
    return { status: 200, body: invite };
  }
  if (method !== "DELETE") return methodNotAllowed();
  // 10006 rather than a bare 404 on purpose. It is what Discord returns, and it means
  // isResourceGone() reads false for an invite that is already gone, because 10006 is not one of the
  // three codes that function treats as "already deleted". See README.
  if (!invite) return errorReply(404, 10006);
  const guild = state.guilds[invite.guild_id];
  if (guild) {
    const denied = requirePermissions(guild, ["MANAGE_CHANNELS"]);
    if (denied) return denied;
  }
  delete state.invites[code];
  return { status: 200, body: invite };
}

/** Order snowflakes numerically, falling back to text for ids a test patched in by hand. */
function compareSnowflakes(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function handleUserRoutes(method: string, segments: string[], query: Record<string, string>): Reply {
  if (segments[1] !== "@me") return unknownRoute();
  if (segments.length === 2) {
    if (method !== "GET") return methodNotAllowed();
    return {
      status: 200,
      body: { id: state.bot.id, username: state.bot.username, discriminator: "0000", bot: true }
    };
  }
  if (segments.length === 3 && segments[2] === "guilds") {
    if (method !== "GET") return methodNotAllowed();
    // Cursor-paginated, as Discord has it, because discord-list-guilds pages until it gets a short
    // page. A mock that answered every request with the whole list would hand that loop the same
    // full page 25 times and produce 25 copies of every guild.
    const joined = Object.values(state.guilds)
      .filter((guild) => guild.bot_in_guild)
      .sort((a, b) => compareSnowflakes(a.id, b.id));
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "", 10) || 200, 1), 200);
    let page = joined;
    if (query.after) page = page.filter((guild) => compareSnowflakes(guild.id, query.after) > 0);
    if (query.before) page = page.filter((guild) => compareSnowflakes(guild.id, query.before) < 0);
    return { status: 200, body: page.slice(0, limit).map(guildSummary) };
  }
  return unknownRoute();
}

function handleApplicationRoutes(method: string, segments: string[], body: unknown): Reply {
  if (segments.length !== 3 || segments[2] !== "commands") return unknownRoute();
  const applicationId = segments[1];

  if (method === "GET") return { status: 200, body: state.commands };

  if (method === "PUT") {
    // Bulk overwrite: the body is the complete command set and replaces whatever was registered.
    if (!Array.isArray(body)) return invalidFormBody("_errors");
    state.commands = body.map((command) => {
      const args = (command ?? {}) as { name?: string; description?: string; type?: number };
      return {
        id: nextSnowflake(),
        application_id: applicationId,
        name: args.name ?? "",
        description: args.description ?? "",
        type: args.type ?? 1
      };
    });
    return { status: 200, body: state.commands };
  }

  if (method === "POST") {
    // Create-or-update one command, which is what the worker's registerSlashCommands does. Discord
    // answers 200 for an update and 201 for a create, keyed on the name already existing.
    const args = (body ?? {}) as { name?: string; description?: string; type?: number };
    if (!args.name) return invalidFormBody("name");
    const existing = state.commands.find((command) => command.name === args.name);
    if (existing) {
      existing.description = args.description ?? existing.description;
      existing.type = args.type ?? existing.type;
      return { status: 200, body: existing };
    }
    const created = {
      id: nextSnowflake(),
      application_id: applicationId,
      name: args.name,
      description: args.description ?? "",
      type: args.type ?? 1
    };
    state.commands.push(created);
    return { status: 201, body: created };
  }

  return methodNotAllowed();
}

/**
 * `POST /oauth2/token` — the install flow's authorization-code exchange.
 *
 * The install callback redeems the `code` here and takes the guild from the response, because that is
 * the only part of Discord's redirect that proves the instructor completed the consent screen for
 * that specific guild (the bot token can confirm any guild the shared bot already sits in). So the
 * mock has to model the two things the callback depends on: a code is single-use, and a `bot` grant
 * names the guild it installed into.
 *
 * Codes are minted by the control plane (`POST /__mock/oauth-code`) rather than by a consent screen
 * nobody can click here. `client_secret` is not verified -- there is no secret to check against --
 * but its absence is, because the callback treats "unconfigured" and "rejected" differently and both
 * paths are worth being able to exercise.
 */
function handleOauthRoutes(method: string, segments: string[], body: unknown): Reply {
  if (segments[1] !== "token") return unknownRoute();
  if (method !== "POST") return methodNotAllowed();

  // Discord takes this endpoint as form-encoded, which is what the callback sends.
  const form = body as Record<string, string> | null;
  const code = form?.code ?? "";
  const grantType = form?.grant_type ?? "";

  if (grantType !== "authorization_code") {
    return { status: 400, body: { error: "unsupported_grant_type" } };
  }
  if (!form?.client_id || !form?.client_secret) {
    return { status: 401, body: { error: "invalid_client" } };
  }

  const issued = state.oauthCodes[code];
  if (!issued) {
    // What a replayed or forged code looks like. The callback surfaces this as "installation links
    // can only be used once" rather than as an outage, so it must be a 400 and not a 5xx.
    return { status: 400, body: { error: "invalid_grant" } };
  }
  // Single-use, like the real thing: redeeming it twice is the replay the callback refuses.
  delete state.oauthCodes[code];

  if (issued.guildId === null) {
    // A grant that carried no `bot` scope, so there is no guild to claim. The callback rejects this
    // rather than falling back to the `guild_id` query parameter.
    return { status: 200, body: { token_type: "Bearer", access_token: "mock-access-token", scope: "identify" } };
  }

  const guild = state.guilds[issued.guildId];
  return {
    status: 200,
    body: {
      token_type: "Bearer",
      access_token: "mock-access-token",
      scope: "bot applications.commands",
      guild: { id: issued.guildId, name: guild?.name ?? "Mock Guild" }
    }
  };
}

function routeDiscord(method: string, path: string, body: unknown, query: Record<string, string>): Reply {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return unknownRoute();
  switch (segments[0]) {
    case "guilds":
      return segments.length >= 2 ? handleGuildRoutes(method, segments, body) : unknownRoute();
    case "channels":
      return segments.length >= 2 ? handleChannelRoutes(method, segments, body) : unknownRoute();
    case "invites":
      return handleInviteRoutes(method, segments);
    case "users":
      return segments.length >= 2 ? handleUserRoutes(method, segments, query) : unknownRoute();
    case "applications":
      return segments.length >= 2 ? handleApplicationRoutes(method, segments, body) : unknownRoute();
    case "oauth2":
      return segments.length >= 2 ? handleOauthRoutes(method, segments, body) : unknownRoute();
    default:
      return unknownRoute();
  }
}

// ============================================================================
// Control plane
// ============================================================================

function skeletonState(): MockState {
  const empty = defaultState();
  return {
    ...empty,
    scenario: "custom",
    faults: [],
    guilds: {},
    invites: {},
    messages: {},
    commands: [],
    oauthCodes: {}
  };
}

function routeControl(method: string, path: string, body: unknown): Reply {
  const segments = path.split("/").filter((segment) => segment !== "");
  // segments[0] is always "__mock" here.
  const resource = segments[1];

  if (resource === "health" && method === "GET") {
    return {
      status: 200,
      body: {
        ok: true,
        scenario: state.scenario,
        uptime_ms: Date.now() - startedAt,
        calls: calls.length,
        guilds: Object.keys(state.guilds).length
      }
    };
  }

  /**
   * Mint an OAuth authorization code, standing in for a completed consent screen.
   *
   * `POST /__mock/oauth-code {"guild_id": "…"}` -> `{"code": "…"}`. Pass `guild_id: null` for a grant
   * that carried no `bot` scope, which is the case the install callback has to refuse.
   */
  if (resource === "oauth-code" && method === "POST") {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: "Body must be a JSON object" } };
    }
    const requested = (body as { guild_id?: unknown }).guild_id;
    if (requested !== null && typeof requested !== "string") {
      return { status: 400, body: { error: "guild_id must be a string or null" } };
    }
    const code = `mockcode${nextSnowflake()}`;
    state.oauthCodes[code] = { guildId: requested };
    return { status: 200, body: { code, guild_id: requested } };
  }

  if (resource === "reset" && method === "POST") {
    state = defaultState();
    calls = [];
    callCounter = 0;
    return { status: 200, body: { ok: true, scenario: state.scenario, state } };
  }

  if (resource === "state") {
    if (method === "GET") return { status: 200, body: state };
    if (method !== "POST") return methodNotAllowed();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: "Body must be a JSON object" } };
    }
    const patch = body as Record<string, unknown>;
    const { replace, state: nested, ...rest } = patch;
    const changes = (nested ?? rest) as Record<string, unknown>;
    state = applyPatch(replace === true ? skeletonState() : state, changes);
    return { status: 200, body: { ok: true, state } };
  }

  if (resource === "calls") {
    if (method === "GET") return { status: 200, body: calls };
    if (method === "DELETE") {
      const cleared = calls.length;
      calls = [];
      callCounter = 0;
      return { status: 200, body: { ok: true, cleared } };
    }
    return methodNotAllowed();
  }

  if (resource === "scenarios" && method === "GET") {
    return { status: 200, body: { scenarios: SCENARIO_NAMES, descriptions: SCENARIO_DESCRIPTIONS } };
  }

  if (resource === "scenario") {
    if (method !== "POST") return methodNotAllowed();
    const name = segments[2];
    const next = name ? scenarioState(name) : null;
    if (!next) {
      return { status: 400, body: { error: `Unknown scenario: ${name ?? "(none)"}`, scenarios: SCENARIO_NAMES } };
    }
    state = next;
    calls = [];
    callCounter = 0;
    return { status: 200, body: { ok: true, scenario: name, state } };
  }

  return { status: 404, body: { error: `No such control endpoint: ${method} ${path}` } };
}

// ============================================================================
// HTTP plumbing
// ============================================================================

function readBody(request: IncomingMessage): Promise<{ raw: string; parsed: unknown; malformed: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({ raw, parsed: undefined, malformed: false });
        return;
      }
      // Discord's /oauth2/token is form-encoded, unlike every other endpoint here. Parsed by
      // content-type rather than by sniffing, so a JSON body that happens to look form-ish is still
      // treated as malformed JSON.
      const contentType = request.headers["content-type"] ?? "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const form: Record<string, string> = {};
        new URLSearchParams(raw).forEach((value, key) => {
          form[key] = value;
        });
        resolve({ raw, parsed: form, malformed: false });
        return;
      }
      try {
        resolve({ raw, parsed: JSON.parse(raw), malformed: false });
      } catch {
        resolve({ raw, parsed: raw, malformed: true });
      }
    });
    request.on("error", reject);
  });
}

/** Strip the `/api/v10` (or any `/api/vNN`) prefix the base URL carries, if present. */
function stripApiPrefix(pathname: string): string {
  const match = pathname.match(/^\/api\/v\d+(\/.*)?$/);
  if (!match) return pathname;
  return match[1] ?? "/";
}

function codeOf(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function send(response: ServerResponse, reply: Reply): void {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": "50",
    "X-RateLimit-Remaining": "49",
    "X-RateLimit-Reset-After": "1.0",
    "X-Pawtograder-Discord-Mock": "1",
    ...(reply.headers ?? {})
  };
  if (reply.status === 204 || reply.body === undefined) {
    response.writeHead(reply.status, headers);
    response.end();
    return;
  }
  const payload = JSON.stringify(reply.body);
  headers["Content-Type"] = "application/json";
  headers["Content-Length"] = String(Buffer.byteLength(payload));
  response.writeHead(reply.status, headers);
  response.end(payload);
}

function record(entry: Omit<CallLogEntry, "id" | "timestamp">): void {
  callCounter += 1;
  calls.push({ id: callCounter, timestamp: new Date().toISOString(), ...entry });
  if (calls.length > MAX_CALL_LOG) calls.splice(0, calls.length - MAX_CALL_LOG);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const rawPath = url.pathname;
  const path = stripApiPrefix(rawPath);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  let body: unknown;
  let malformed = false;
  try {
    const read = await readBody(request);
    body = read.parsed;
    malformed = read.malformed;
  } catch {
    send(response, { status: 413, body: { message: "413: Payload Too Large", code: 0 } });
    return;
  }

  if (path === "/__mock" || path.startsWith("/__mock/")) {
    send(response, routeControl(method, path, body));
    return;
  }

  let reply: Reply;
  const fault = takeFault(method, path);
  if (fault) {
    if (fault.delay_ms) await delay(fault.delay_ms);
    reply = faultReply(fault);
  } else if (malformed) {
    reply = errorReply(400, 50109);
  } else if (state.require_auth && !/^Bot\s+\S+/.test(request.headers.authorization ?? "")) {
    // 401 rather than 403: the worker's checkGuildMembership treats a 401 as retriable, on the
    // reading that the token is wrong or mid-rotation, and that path deserves to be reachable.
    reply = { status: 401, body: { message: "401: Unauthorized", code: 0 } };
  } else {
    reply = routeDiscord(method, path, body, query);
  }

  record({
    method,
    path,
    raw_path: rawPath,
    query,
    body: body ?? null,
    status: reply.status,
    code: codeOf(reply.body)
  });
  send(response, reply);
}

export function createMockServer(): Server {
  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      send(response, { status: 500, body: { message: `500: ${message}`, code: 0 } });
    });
  });
}

/**
 * Bind address. Defaults to loopback, which is right for a test process talking
 * to the mock in-process.
 *
 * Supabase Edge Functions run inside a container, so a function calling
 * `127.0.0.1` reaches the container's own loopback and gets ECONNREFUSED. To
 * serve those, bind somewhere the container can route to — `DISCORD_MOCK_HOST=0.0.0.0`
 * — and point the deployment at `host.docker.internal` (172.17.0.1 from inside
 * the edge runtime).
 */
const DEFAULT_HOST = "127.0.0.1";

export function startMockServer(
  port: number = Number(process.env.DISCORD_MOCK_PORT ?? DEFAULT_PORT),
  host: string = process.env.DISCORD_MOCK_HOST ?? DEFAULT_HOST
): Server {
  const server = createMockServer();
  server.listen(port, host, () => {
    const base = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
    // eslint-disable-next-line no-console
    console.log(`[discord-mock] listening on ${base}`);
    // eslint-disable-next-line no-console
    console.log(`[discord-mock] point a deployment at it with DISCORD_API_BASE_URL=${base}/api/v10`);
    // eslint-disable-next-line no-console
    console.log(`[discord-mock] scenario "${state.scenario}", control plane at ${base}/__mock/`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

/** Test helpers that drive the world in-process rather than over HTTP. */
export function currentState(): MockState {
  return state;
}

export function currentCalls(): CallLogEntry[] {
  return calls;
}

// Runs when invoked as a script (`npx tsx tests/mocks/discord/server.ts`), and stays quiet when
// imported. `require.main` is unavailable once this is loaded as ESM, and `import.meta` once it is
// loaded as CJS, so the entry point is identified by argv instead of by either.
const entry = process.argv[1] ? basename(process.argv[1]) : "";
if (process.env.DISCORD_MOCK_AUTOSTART !== "0" && (entry === "server.ts" || entry === "server.js")) {
  startMockServer();
}
