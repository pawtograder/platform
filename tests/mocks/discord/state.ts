/**
 * The world the Discord mock serves, and the scenarios that pose it.
 *
 * Kept apart from server.ts so the shapes can be imported by tests without starting a listener, and
 * so a scenario is a data change rather than a code change.
 *
 * Two rules are modelled here rather than in the request handlers, because they are the two Discord
 * actually enforces and the two the integration gets wrong:
 *
 *   1. The bot's effective permission bitfield is the union of its roles' bitfields, including
 *      `@everyone` -- whose role id is the guild id and which never appears in `member.roles`.
 *   2. A member may only touch a role whose `position` is strictly below its own highest role.
 *      Equal positions fail, and Discord reports that as `50013 Missing Permissions`, the same code
 *      it returns for not holding Manage Roles at all.
 *
 * Both mirror supabase/functions/_shared/DiscordPermissions.ts. If that file's rules change, these
 * have to change with them or the mock stops being evidence of anything.
 */

/** Discord permission flags as bit positions, matching DiscordPermissions.ts. */
export const DISCORD_PERMISSION_BITS = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_ROLES: 1n << 28n
} as const;

export type PermissionFlag = keyof typeof DISCORD_PERMISSION_BITS;

export type MockRole = {
  id: string;
  name: string;
  /** Higher is more powerful. `@everyone` sits at 0. */
  position: number;
  /** Decimal string, the way Discord serializes a 64-bit bitfield. */
  permissions: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  managed?: boolean;
};

export type MockMember = {
  user: { id: string; username: string; global_name?: string | null; bot?: boolean };
  roles: string[];
  nick?: string | null;
  joined_at?: string;
};

/**
 * A Discord channel permission overwrite.
 *
 * `type` is Discord's: 0 = role, 1 = member. `allow` and `deny` are decimal bitfield STRINGS, which
 * is how Discord serialises them.
 */
export type MockPermissionOverwrite = {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
};

export type MockChannel = {
  id: string;
  name: string;
  /** 0 = text, 2 = voice, 4 = category, 15 = forum. */
  type: number;
  guild_id: string;
  parent_id?: string | null;
  topic?: string | null;
  position?: number;
  /**
   * Per-channel overwrites, serialised on the channel object exactly as Discord does.
   *
   * These are the reason a guild-level permission check is not sufficient: a bot can hold Send
   * Messages across the server and be denied it in one channel. The mock enforces them so that
   * failure is reachable, rather than only describable.
   */
  permission_overwrites?: MockPermissionOverwrite[];
};

export type MockGuild = {
  id: string;
  name: string;
  owner_id?: string;
  /**
   * False models a guild the bot has been removed from, or was never added to. Every guild-scoped
   * route then answers `404 Unknown Guild`, which is what Discord tells a bot about a guild it
   * cannot see -- indistinguishable, deliberately, from a guild that does not exist.
   */
  bot_in_guild: boolean;
  /** Role ids the bot holds. `@everyone` is implied and must not be listed. */
  bot_roles: string[];
  roles: MockRole[];
  members: Record<string, MockMember>;
  channels: MockChannel[];
};

export type MockInvite = {
  code: string;
  guild_id: string;
  channel_id: string;
  max_age: number;
  max_uses: number;
  uses: number;
  created_at: string;
};

export type MockMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  embeds: unknown[];
  author: { id: string; username: string; bot: boolean };
  timestamp: string;
  edited_timestamp: string | null;
};

export type MockCommand = {
  id: string;
  application_id: string;
  name: string;
  description?: string;
  type?: number;
};

/**
 * One injected failure.
 *
 * `path` is a regular expression matched against the prefix-stripped path (`/guilds/123/roles`), so
 * a rule can be as wide as everything or as narrow as one route. `times` counts down and the rule
 * retires at zero, which is how "429 twice then succeed" is expressed.
 */
export type FaultRule = {
  /** HTTP method to match, case-insensitive. Omit to match every method. */
  method?: string;
  /** Regular expression source matched against the prefix-stripped path. Omit to match every path. */
  path?: string;
  status: number;
  /** Discord JSON error code. Omit and the mock picks the conventional one for the status. */
  code?: number;
  message?: string;
  /** Seconds, for a 429. Both `Retry-After` and `X-RateLimit-Reset-After` carry it. */
  retry_after?: number;
  /** Stall this long before answering, to exercise the callers' fetch deadlines. */
  delay_ms?: number;
  /** Number of matching requests to fail. Omit for "every one". */
  times?: number;
};

export type MockState = {
  /** Name of the scenario last applied, echoed by the health and state endpoints. */
  scenario: string;
  bot: { id: string; username: string; application_id: string };
  /** When true, a Discord route without an `Authorization: Bot …` header answers 401. */
  require_auth: boolean;
  faults: FaultRule[];
  guilds: Record<string, MockGuild>;
  invites: Record<string, MockInvite>;
  messages: Record<string, MockMessage>;
  commands: MockCommand[];
  /**
   * Outstanding OAuth authorization codes, keyed by code.
   *
   * `guildId: null` models a grant that carried no `bot` scope, so the token response names no guild
   * -- the case the install callback must refuse rather than falling back to its `guild_id` query
   * parameter. Minted through `POST /__mock/oauth-code`, since there is no consent screen to click.
   */
  oauthCodes: Record<string, { guildId: string | null }>;
};

/**
 * The default guild id contains "429" on purpose.
 *
 * DiscordErrorClassification.ts documents a misclassification caused by exactly that: snowflakes are
 * 17 to 19 digits, the wrapper interpolates them into error messages, and a bare "429" substring
 * search read `guild 1142900000000000000` as a rate limit. Every scenario here uses that id, so the
 * regression stays covered by every test that touches the mock.
 */
export const DEFAULT_GUILD_ID = "1142900000000000000";
export const DEFAULT_BOT_USER_ID = "1300000000000000001";
export const DEFAULT_APPLICATION_ID = "1300000000000000002";
export const BOT_ROLE_ID = "1200000000000000001";
export const STUDENT_ROLE_ID = "1200000000000000002";
export const GRADER_ROLE_ID = "1200000000000000003";
export const INSTRUCTOR_ROLE_ID = "1200000000000000004";
/** In the guild, holding the student role. */
export const JOINED_MEMBER_ID = "2000000000000000001";
/** In the guild, holding no class role. */
export const UNROLED_MEMBER_ID = "2000000000000000002";
/** Never in any guild, so member lookups for it answer 404 Unknown Member. */
export const ABSENT_MEMBER_ID = "2000000000000000003";
export const GENERAL_CHANNEL_ID = "1400000000000000001";
export const CATEGORY_CHANNEL_ID = "1400000000000000002";
/** A second text channel, so a scenario can deny one and leave another usable. */
export const ANNOUNCEMENTS_CHANNEL_ID = "1400000000000000003";

function bits(...flags: PermissionFlag[]): string {
  return flags.reduce((acc, flag) => acc | DISCORD_PERMISSION_BITS[flag], 0n).toString();
}

/** What a course server's `@everyone` typically grants, and enough for the bot's baseline. */
const EVERYONE_PERMISSIONS = bits("CREATE_INSTANT_INVITE", "VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY");
/** The two the bot cannot get from `@everyone`. */
const BOT_ROLE_PERMISSIONS = bits("MANAGE_CHANNELS", "MANAGE_ROLES");

const JOINED_AT = "2026-01-15T10:00:00.000000+00:00";

function everyoneRole(guildId: string, permissions: string = EVERYONE_PERMISSIONS): MockRole {
  return { id: guildId, name: "@everyone", position: 0, permissions, managed: false };
}

function classRoles(): MockRole[] {
  return [
    { id: STUDENT_ROLE_ID, name: "Pawtograder Student", position: 3, permissions: "0" },
    { id: GRADER_ROLE_ID, name: "Pawtograder Grader", position: 4, permissions: "0" },
    { id: INSTRUCTOR_ROLE_ID, name: "Pawtograder Instructor", position: 5, permissions: "0" }
  ];
}

function defaultMembers(): Record<string, MockMember> {
  return {
    [JOINED_MEMBER_ID]: {
      user: { id: JOINED_MEMBER_ID, username: "student-one" },
      roles: [STUDENT_ROLE_ID],
      nick: null,
      joined_at: JOINED_AT
    },
    [UNROLED_MEMBER_ID]: {
      user: { id: UNROLED_MEMBER_ID, username: "student-two" },
      roles: [],
      nick: null,
      joined_at: JOINED_AT
    }
  };
}

function defaultChannels(guildId: string): MockChannel[] {
  return [
    { id: CATEGORY_CHANNEL_ID, name: "pawtograder", type: 4, guild_id: guildId, parent_id: null, position: 0 },
    {
      id: GENERAL_CHANNEL_ID,
      name: "general",
      type: 0,
      guild_id: guildId,
      parent_id: CATEGORY_CHANNEL_ID,
      topic: "Class announcements",
      position: 1
    }
  ];
}

/**
 * A guild where every required permission is held and the bot's role sits above every class role.
 *
 * `botRolePermissions` and `botRolePosition` are the two knobs the unhappy scenarios turn, and
 * `everyonePermissions` is the third: several of the required bits reach the bot only through
 * `@everyone`, so taking one away there is how a real server loses it.
 */
function guildTemplate(options?: {
  botRolePermissions?: string;
  botRolePosition?: number;
  everyonePermissions?: string;
  botInGuild?: boolean;
  members?: Record<string, MockMember>;
  channels?: MockChannel[];
}): MockGuild {
  const guildId = DEFAULT_GUILD_ID;
  const botRole: MockRole = {
    id: BOT_ROLE_ID,
    name: "Pawtograder",
    position: options?.botRolePosition ?? 10,
    permissions: options?.botRolePermissions ?? BOT_ROLE_PERMISSIONS,
    managed: true
  };
  return {
    id: guildId,
    name: "CS 3200 Fall 2026",
    owner_id: "9000000000000000001",
    bot_in_guild: options?.botInGuild ?? true,
    bot_roles: options?.botInGuild === false ? [] : [BOT_ROLE_ID],
    roles: [everyoneRole(guildId, options?.everyonePermissions), ...classRoles(), botRole],
    members: options?.members ?? defaultMembers(),
    channels: options?.channels ?? defaultChannels(guildId)
  };
}

function baseState(scenario: string, guilds: MockGuild[], faults: FaultRule[] = []): MockState {
  const byId: Record<string, MockGuild> = {};
  for (const guild of guilds) byId[guild.id] = guild;
  return {
    scenario,
    bot: { id: DEFAULT_BOT_USER_ID, username: "pawtograder", application_id: DEFAULT_APPLICATION_ID },
    require_auth: false,
    faults,
    guilds: byId,
    invites: {},
    messages: {},
    commands: [],
    oauthCodes: {}
  };
}

export const SCENARIO_DESCRIPTIONS: Record<string, string> = {
  healthy: "Bot in the guild, every required permission held, bot role above every class role.",
  "bot-not-in-guild": "The guild exists but the bot is not a member, so guild routes answer 404 / 10004.",
  "guild-gone": "No guild at all, the wrong discord_server_id case. Guild routes answer 404 / 10004.",
  "missing-manage-roles": "Bot holds every permission except Manage Roles, so role writes answer 403 / 50013.",
  "missing-view-channel": "Bot cannot see channels, so listing them answers 403 / 50001 and no invite can be made.",
  "bot-role-too-low":
    "Bot has Manage Roles but its role ties the instructor role's position, so that write is refused.",
  "no-text-channel": "Guild has only a category, so createGuildInvite fails before any invite request.",
  "channel-invite-denied":
    "Guild-level permissions are complete, but the FIRST text channel denies Create Invite by overwrite while a second text channel allows it. An invite path that tries only the first channel fails here.",
  "channel-send-denied":
    "Guild-level permissions are complete, but #general denies Send Messages by overwrite. A guild-level-only audit reports this server healthy.",
  "member-not-joined": "Guild is healthy but has no members, so member lookups answer 404 / 10007.",
  "rate-limited": "Every route answers 429 with a Retry-After of 1.5 seconds."
};

export const SCENARIO_NAMES: string[] = Object.keys(SCENARIO_DESCRIPTIONS);

/** Build a scenario's world. Returns null for an unknown name so the caller can answer 400. */
export function scenarioState(name: string): MockState | null {
  switch (name) {
    case "healthy":
      return baseState("healthy", [guildTemplate()]);
    case "bot-not-in-guild":
      return baseState("bot-not-in-guild", [guildTemplate({ botInGuild: false })]);
    case "guild-gone":
      return baseState("guild-gone", []);
    case "missing-manage-roles":
      return baseState("missing-manage-roles", [guildTemplate({ botRolePermissions: bits("MANAGE_CHANNELS") })]);
    case "missing-view-channel":
      return baseState("missing-view-channel", [
        guildTemplate({
          everyonePermissions: bits("CREATE_INSTANT_INVITE", "SEND_MESSAGES", "READ_MESSAGE_HISTORY")
        })
      ]);
    case "bot-role-too-low":
      // Position 5 ties the instructor role. Discord's rule is strict inequality, so the tie fails:
      // the student and grader roles at 3 and 4 still succeed, which is what makes this scenario
      // sharper than simply putting the bot at the bottom.
      return baseState("bot-role-too-low", [guildTemplate({ botRolePosition: 5 })]);
    case "channel-invite-denied": {
      // Two text channels. The first by position denies CREATE_INSTANT_INVITE to the bot's role; the
      // second grants it. Both remain VISIBLE, which is the point: a VIEW_CHANNEL denial would remove
      // the channel from GET /guilds/{id}/channels altogether and the caller would simply skip it.
      // Denying only the invite bit keeps the channel in the list and makes it a trap.
      const guildId = DEFAULT_GUILD_ID;
      return baseState("channel-invite-denied", [
        guildTemplate({
          channels: [
            { id: CATEGORY_CHANNEL_ID, name: "pawtograder", type: 4, guild_id: guildId, parent_id: null, position: 0 },
            {
              id: GENERAL_CHANNEL_ID,
              name: "general",
              type: 0,
              guild_id: guildId,
              parent_id: CATEGORY_CHANNEL_ID,
              position: 1,
              permission_overwrites: [{ id: BOT_ROLE_ID, type: 0, allow: "0", deny: bits("CREATE_INSTANT_INVITE") }]
            },
            {
              id: ANNOUNCEMENTS_CHANNEL_ID,
              name: "announcements",
              type: 0,
              guild_id: guildId,
              parent_id: CATEGORY_CHANNEL_ID,
              position: 2
            }
          ]
        })
      ]);
    }
    case "channel-send-denied": {
      const guildId = DEFAULT_GUILD_ID;
      return baseState("channel-send-denied", [
        guildTemplate({
          channels: [
            { id: CATEGORY_CHANNEL_ID, name: "pawtograder", type: 4, guild_id: guildId, parent_id: null, position: 0 },
            {
              id: GENERAL_CHANNEL_ID,
              name: "general",
              type: 0,
              guild_id: guildId,
              parent_id: CATEGORY_CHANNEL_ID,
              position: 1,
              permission_overwrites: [{ id: BOT_ROLE_ID, type: 0, allow: "0", deny: bits("SEND_MESSAGES") }]
            }
          ]
        })
      ]);
    }
    case "no-text-channel":
      return baseState("no-text-channel", [
        guildTemplate({
          channels: [
            {
              id: CATEGORY_CHANNEL_ID,
              name: "pawtograder",
              type: 4,
              guild_id: DEFAULT_GUILD_ID,
              parent_id: null,
              position: 0
            }
          ]
        })
      ]);
    case "member-not-joined":
      return baseState("member-not-joined", [guildTemplate({ members: {} })]);
    case "rate-limited":
      return baseState("rate-limited", [guildTemplate()], [{ status: 429, retry_after: 1.5 }]);
    default:
      return null;
  }
}

/** The world a fresh server, and `POST /__mock/reset`, start from. */
export function defaultState(): MockState {
  return scenarioState("healthy") as MockState;
}

/** Parse a bitfield the way DiscordPermissions.parsePermissionBits does: unreadable means zero. */
export function parsePermissionBits(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  const text = String(value).trim();
  if (text === "" || !/^\d+$/.test(text)) return 0n;
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

/** The bot's effective guild permissions: the union of its roles' bitfields, plus `@everyone`. */
export function botPermissions(guild: MockGuild): bigint {
  const held = new Set<string>(guild.bot_roles);
  held.add(guild.id);
  let acc = 0n;
  for (const role of guild.roles) {
    if (held.has(role.id)) acc |= parsePermissionBits(role.permissions);
  }
  return acc;
}

/** True when the bot holds the flag, or holds Administrator, which Discord treats as holding all. */
/**
 * The bot's effective permissions **in a channel**, applying Discord's overwrite precedence.
 *
 * Order is Discord's, and the order matters: base role permissions, then the @everyone overwrite,
 * then the union of role overwrites (all denies collected before any allow), then the member-specific
 * overwrite. Administrator short-circuits before any of it. Denying VIEW_CHANNEL makes the rest moot,
 * which callers handle by checking VIEW_CHANNEL first.
 */
export function botChannelPermissions(guild: MockGuild, channel: MockChannel, botUserId?: string): bigint {
  const base = botPermissions(guild);
  if ((base & DISCORD_PERMISSION_BITS.ADMINISTRATOR) !== 0n) return base;

  // A channel inherits its category's overwrites unless it has its own for the same target. Modelled
  // by applying the parent's first, so a channel-level entry wins.
  const parent = channel.parent_id ? (guild.channels.find((c) => c.id === channel.parent_id) ?? null) : null;
  const layers = [parent?.permission_overwrites ?? [], channel.permission_overwrites ?? []];

  let acc = base;
  for (const overwrites of layers) {
    if (overwrites.length === 0) continue;
    const held = new Set<string>(guild.bot_roles);

    // 1. @everyone, whose overwrite id is the guild id.
    const everyone = overwrites.find((o) => o.id === guild.id && o.type === 0);
    if (everyone) {
      acc &= ~parsePermissionBits(everyone.deny);
      acc |= parsePermissionBits(everyone.allow);
    }

    // 2. Role overwrites, denies before allows across the whole set -- not per role. Applying each
    //    role's deny/allow in sequence would let role order decide the answer, which Discord does not.
    let roleDeny = 0n;
    let roleAllow = 0n;
    for (const o of overwrites) {
      if (o.type !== 0 || o.id === guild.id || !held.has(o.id)) continue;
      roleDeny |= parsePermissionBits(o.deny);
      roleAllow |= parsePermissionBits(o.allow);
    }
    acc &= ~roleDeny;
    acc |= roleAllow;

    // 3. The member-specific overwrite, which outranks every role.
    // The bot's user id is on MockState, not on the guild, so callers pass it. Absent, the
    // member-specific layer is skipped rather than guessed.
    const member = botUserId ? overwrites.find((o) => o.id === botUserId && o.type === 1) : undefined;
    if (member) {
      acc &= ~parsePermissionBits(member.deny);
      acc |= parsePermissionBits(member.allow);
    }
  }
  return acc;
}

/** Whether the bot holds `flag` in this specific channel. */
export function botHasChannelPermission(
  guild: MockGuild,
  channel: MockChannel,
  flag: PermissionFlag,
  botUserId?: string
): boolean {
  const granted = botChannelPermissions(guild, channel, botUserId);
  if ((granted & DISCORD_PERMISSION_BITS.ADMINISTRATOR) !== 0n) return true;
  // VIEW_CHANNEL is a precondition for everything else in a channel.
  if (flag !== "VIEW_CHANNEL" && (granted & DISCORD_PERMISSION_BITS.VIEW_CHANNEL) === 0n) return false;
  return (granted & DISCORD_PERMISSION_BITS[flag]) !== 0n;
}

export function botHasPermission(guild: MockGuild, flag: PermissionFlag): boolean {
  const granted = botPermissions(guild);
  if ((granted & DISCORD_PERMISSION_BITS.ADMINISTRATOR) !== 0n) return true;
  return (granted & DISCORD_PERMISSION_BITS[flag]) !== 0n;
}

/** The highest `position` among the bot's roles. `@everyone` is the floor at 0. */
export function botHighestPosition(guild: MockGuild): number {
  const held = new Set<string>(guild.bot_roles);
  let highest = 0;
  for (const role of guild.roles) {
    if (!held.has(role.id)) continue;
    if (role.position > highest) highest = role.position;
  }
  return highest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge a patch into the world. Objects merge key by key, arrays and scalars replace.
 *
 * Arrays replacing rather than concatenating is the useful default here: a test that sets
 * `roles: [...]` means those roles and no others, and a test that wants to add one reads the state
 * first. Same for `faults`, where appending would leave an earlier scenario's 429 in place.
 */
export function applyPatch<T>(target: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (patch === undefined ? target : patch) as T;
  if (!isPlainObject(target)) return patch as unknown as T;
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isPlainObject(value) ? applyPatch(merged[key], value) : value;
  }
  return merged as unknown as T;
}
