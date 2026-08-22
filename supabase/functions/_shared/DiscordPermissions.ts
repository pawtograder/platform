/**
 * The Discord permissions the Pawtograder bot needs, and the two ways it can fail to have them.
 *
 * An instructor who invites the bot with a hand-edited OAuth URL, or who later tightens the bot's
 * role in the server's settings, gets a guild the bot can see but cannot work in. Every downstream
 * symptom is the same 403 -- roles are not assigned, channels are not created, invites are not
 * issued -- and none of it names the missing permission, so this module exists to answer the
 * question before any of that runs.
 *
 * Two separate checks, because Discord enforces two separate rules:
 *
 *   1. Does the bot hold the permission bits at all? -> `missingPermissions`
 *   2. Is the bot's own role high enough to USE them on the class's roles? -> `canManageRoles`
 *
 * The second is the one that bites. Discord refuses to add or remove a role whose `position` is at
 * or above the acting member's highest role, and it reports that refusal as
 * `50013 Missing Permissions` -- the identical code you get for not holding Manage Roles at all.
 * So a server where the bot genuinely has Manage Roles, and where the permission audit therefore
 * passes cleanly, still fails every single role assignment, with an error that says the opposite of
 * what is wrong. It is undiagnosable from the error alone; you have to compare positions. Hence
 * `canManageRoles`, and hence the bot's role position being part of the check's response.
 *
 * Kept free of Deno, fetch and env reads so it is unit-testable on its own.
 *
 * Run from supabase/functions:  deno test --no-check _shared/DiscordPermissions.test.ts
 */

/**
 * Discord permission flags, as bit positions in a 64-bit field.
 *
 * BigInt rather than number: the field is documented as a 64-bit integer and the high flags are
 * already past 2^53, so anything computed in a JS `number` silently loses precision. Discord itself
 * serialises the field as a decimal *string* for the same reason.
 *
 * Only the flags this feature reasons about are listed. Full table:
 * https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags
 */
export const DISCORD_PERMISSION_BITS = {
  /** Create invites, which is how students are brought into the class server. */
  CREATE_INSTANT_INVITE: 1n << 0n,
  /** Implies every other permission, and bypasses channel overwrites. */
  ADMINISTRATOR: 1n << 3n,
  /** Create and delete the per-assignment / per-section channels. */
  MANAGE_CHANNELS: 1n << 4n,
  /** See a channel at all. Without it the bot cannot even list what it is meant to manage. */
  VIEW_CHANNEL: 1n << 10n,
  /** Post notifications and digests. */
  SEND_MESSAGES: 1n << 11n,
  /** Read back what it posted, so digests can update rather than duplicate. */
  READ_MESSAGE_HISTORY: 1n << 16n,
  /** Create the class roles and assign them to students. */
  MANAGE_ROLES: 1n << 28n
} as const;

/** One required permission, with the label rendered wherever it is reported. */
export type RequiredPermission = {
  /** Discord's own flag name, for logs and for matching against the API docs. */
  readonly flag: keyof typeof DISCORD_PERMISSION_BITS;
  /** The bit itself. */
  readonly bit: bigint;
  /** Human-readable name, exactly as Discord's own role editor labels it. */
  readonly label: string;
  /** What Pawtograder stops being able to do without it. */
  readonly reason: string;
};

/**
 * The canonical required set.
 *
 * Single source of truth on purpose: the install URL's `permissions` param, the edge function's
 * audit, and the UI's checklist all read this, so an instructor cannot be shown a list that differs
 * from the one the bot was actually invited with. Adding a permission here changes all three.
 *
 * Administrator is deliberately NOT required. Asking a course server's owner for Administrator to
 * run a class bot is a request most will refuse, and rightly.
 */
export const REQUIRED_BOT_PERMISSIONS: readonly RequiredPermission[] = [
  {
    flag: "VIEW_CHANNEL",
    bit: DISCORD_PERMISSION_BITS.VIEW_CHANNEL,
    label: "View Channels",
    reason: "Read the server's channel list to find where to post and where to create invites."
  },
  {
    flag: "MANAGE_ROLES",
    bit: DISCORD_PERMISSION_BITS.MANAGE_ROLES,
    label: "Manage Roles",
    reason: "Create the class roles and assign them to enrolled students."
  },
  {
    flag: "MANAGE_CHANNELS",
    bit: DISCORD_PERMISSION_BITS.MANAGE_CHANNELS,
    label: "Manage Channels",
    reason: "Create and remove the per-assignment and per-section channels."
  },
  {
    flag: "CREATE_INSTANT_INVITE",
    bit: DISCORD_PERMISSION_BITS.CREATE_INSTANT_INVITE,
    label: "Create Invite",
    reason: "Issue the join links students use to enter the class server."
  },
  {
    flag: "SEND_MESSAGES",
    bit: DISCORD_PERMISSION_BITS.SEND_MESSAGES,
    label: "Send Messages",
    reason: "Post discussion notifications and digests."
  },
  {
    flag: "READ_MESSAGE_HISTORY",
    bit: DISCORD_PERMISSION_BITS.READ_MESSAGE_HISTORY,
    label: "Read Message History",
    reason: "Find the digest it posted earlier so it can edit it instead of posting a duplicate."
  }
] as const;

/**
 * The bitfield to put in the OAuth install URL's `permissions` param.
 *
 * Computed from `REQUIRED_BOT_PERMISSIONS` rather than written out, so the URL and the audit cannot
 * drift.
 */
export function requiredPermissionsBits(): bigint {
  return REQUIRED_BOT_PERMISSIONS.reduce((acc, p) => acc | p.bit, 0n);
}

/**
 * True when the bitfield carries Administrator, which Discord treats as holding every permission.
 *
 * Worth naming rather than inlining: a bot in an Administrator role has none of the required bits
 * set explicitly, so a naive per-bit audit reports all six as missing on a server where it can in
 * fact do everything.
 */
export function hasAdministrator(granted: bigint): boolean {
  return (granted & DISCORD_PERMISSION_BITS.ADMINISTRATOR) !== 0n;
}

/**
 * Human-readable labels for the required permissions that `granted` does not include.
 *
 * Returns them in `REQUIRED_BOT_PERMISSIONS` order so the list an instructor sees is stable across
 * calls, and empty when nothing is missing.
 */
export function missingPermissions(granted: bigint): string[] {
  if (hasAdministrator(granted)) return [];
  return REQUIRED_BOT_PERMISSIONS.filter((p) => (granted & p.bit) === 0n).map((p) => p.label);
}

/**
 * Parse a permission bitfield as Discord sends it.
 *
 * Discord serialises permissions as a decimal string (`"268435456"`), but role and member payloads
 * from other sources -- fixtures, mocks, older code -- sometimes carry a number. Anything absent or
 * unparseable becomes 0n: an unreadable field must not be read as "has everything", or the audit
 * would pass on exactly the malformed responses it should flag.
 */
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

/**
 * Discord's OAuth2 authorization endpoint.
 *
 * Deliberately NOT routed through `discordApiBase()`. That override exists so REST calls can be
 * pointed at a mock server; this is a link handed to a human in a browser, and a mock has no consent
 * screen to show them. Sending an instructor to `http://127.0.0.1:8788/oauth2/authorize` during a
 * local run would just be a broken button, so the install URL stays on discord.com unconditionally.
 */
export const DISCORD_OAUTH_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";

/**
 * Build the URL that installs the bot, pre-ticked with exactly `REQUIRED_BOT_PERMISSIONS`.
 *
 * Pure -- the caller supplies the application ID, because this module reads no environment.
 *
 * Passing `guildId` pins the consent screen to that one server and hides the server picker, which
 * is what you want when re-installing into a class's existing guild: it removes the chance of an
 * instructor picking the wrong server and pointing a second course at it. With no guild configured
 * yet the picker is the whole point, so both params are omitted.
 */
export function botInstallUrl(args: { applicationId: string; guildId?: string | null }): string {
  const params = new URLSearchParams({
    client_id: args.applicationId,
    // Space-separated per the OAuth2 spec; URLSearchParams encodes the space as `+`, which is the
    // form Discord's own documentation shows.
    scope: "bot applications.commands",
    permissions: requiredPermissionsBits().toString()
  });
  if (args.guildId) {
    params.set("guild_id", args.guildId);
    params.set("disable_guild_select", "true");
  }
  return `${DISCORD_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/** The subset of a Discord role object this module needs. */
export type DiscordRoleLike = {
  id: string;
  name?: string;
  /** Decimal string, per Discord's own serialisation. */
  permissions?: string | number | bigint | null;
  position?: number | null;
};

/**
 * Combine the roles a member holds into one effective permission bitfield.
 *
 * Discord does not report a member's permissions directly on the member object; it reports the role
 * IDs, and guild-level permissions are the union of those roles' bitfields. `@everyone` is part of
 * that union but is never listed in `member.roles`, so it has to be added back -- and its role ID is
 * the guild's own ID, which is why `guildId` is a parameter. Omitting it would under-report on any
 * server whose baseline @everyone permissions are what actually grant the bot View Channel.
 *
 * Channel-level overwrites are NOT modelled. They can only ever subtract from this, so a pass here
 * is necessary but not sufficient; the point is to catch the guild-level misconfiguration, which is
 * the one instructors actually hit.
 */
export function effectivePermissions(args: {
  guildRoles: readonly DiscordRoleLike[];
  memberRoleIds: readonly string[];
  guildId?: string | null;
}): bigint {
  const { guildRoles, memberRoleIds, guildId } = args;
  const held = new Set<string>(memberRoleIds);
  if (guildId) held.add(guildId);
  let bits = 0n;
  for (const role of guildRoles) {
    if (held.has(role.id)) bits |= parsePermissionBits(role.permissions);
  }
  return bits;
}

/**
 * The highest `position` among the roles a member holds.
 *
 * This is the number Discord compares against when deciding whether the member may touch a role.
 * `@everyone` sits at position 0 and is the floor, so a member with no roles at all is 0 rather
 * than undefined.
 */
export function highestRolePosition(args: {
  guildRoles: readonly DiscordRoleLike[];
  memberRoleIds: readonly string[];
}): number {
  const held = new Set<string>(args.memberRoleIds);
  let highest = 0;
  for (const role of args.guildRoles) {
    if (!held.has(role.id)) continue;
    const position = typeof role.position === "number" ? role.position : 0;
    if (position > highest) highest = position;
  }
  return highest;
}

/**
 * Whether the bot's role sits strictly above every class role.
 *
 * Discord's rule is strict inequality: a member can only modify a role whose position is BELOW its
 * own highest role. Equal positions fail, which is why the comparison below is `<` and not `<=`.
 * Getting that one character wrong means reporting a healthy install for a server where every role
 * assignment will return `50013 Missing Permissions` with no further explanation.
 *
 * Administrator does NOT exempt a bot from this. The hierarchy rule is checked independently of the
 * permission bits, so `hasAdministrator` deliberately has no say here -- an Administrator bot whose
 * role sits below a class role still cannot assign it.
 *
 * Empty `classRolePositions` returns true: a class with no roles created yet has nothing that could
 * be blocked, and reporting a problem there would flag every server the moment the bot is invited.
 */
export function canManageRoles(args: { botHighestPosition: number; classRolePositions: readonly number[] }): boolean {
  const { botHighestPosition, classRolePositions } = args;
  if (classRolePositions.length === 0) return true;
  return classRolePositions.every((position) => position < botHighestPosition);
}
