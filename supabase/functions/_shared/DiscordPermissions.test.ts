/**
 * Unit tests for the Discord bot permission audit.
 *
 * The bit values below are written out as literals on purpose. If someone "simplifies"
 * DISCORD_PERMISSION_BITS by recomputing a shift, these tests are what notices that the bot is now
 * being invited with the wrong permissions -- a failure whose only symptom in production is a 403
 * from an unrelated operation.
 *
 * Run from supabase/functions:  deno test --no-check _shared/DiscordPermissions.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  DISCORD_PERMISSION_BITS,
  REQUIRED_BOT_PERMISSIONS,
  botInstallUrl,
  canManageRoles,
  effectivePermissions,
  hasAdministrator,
  highestRolePosition,
  missingPermissions,
  parsePermissionBits,
  requiredPermissionsBits
} from "./DiscordPermissions.ts";

/** Every label, in the order the module reports them. */
const ALL_LABELS = REQUIRED_BOT_PERMISSIONS.map((p) => p.label);

Deno.test("DISCORD_PERMISSION_BITS: the bit values match Discord's published table", () => {
  assertEquals(DISCORD_PERMISSION_BITS.CREATE_INSTANT_INVITE, 1n);
  assertEquals(DISCORD_PERMISSION_BITS.ADMINISTRATOR, 8n);
  assertEquals(DISCORD_PERMISSION_BITS.MANAGE_CHANNELS, 16n);
  assertEquals(DISCORD_PERMISSION_BITS.VIEW_CHANNEL, 1024n);
  assertEquals(DISCORD_PERMISSION_BITS.SEND_MESSAGES, 2048n);
  assertEquals(DISCORD_PERMISSION_BITS.READ_MESSAGE_HISTORY, 65536n);
  assertEquals(DISCORD_PERMISSION_BITS.MANAGE_ROLES, 268435456n);
});

Deno.test("requiredPermissionsBits: the union of the required set, and no Administrator", () => {
  assertEquals(requiredPermissionsBits(), 1n | 16n | 1024n | 2048n | 65536n | 268435456n);
  // Asking a course server's owner for Administrator is a request most would refuse.
  assertEquals(hasAdministrator(requiredPermissionsBits()), false);
});

Deno.test("missingPermissions: no permissions at all reports every requirement", () => {
  assertEquals(missingPermissions(0n), ALL_LABELS);
});

Deno.test("missingPermissions: the exact required set reports nothing missing", () => {
  assertEquals(missingPermissions(requiredPermissionsBits()), []);
});

Deno.test("missingPermissions: Administrator implies everything", () => {
  // A bot in an Administrator role has none of the six bits set explicitly. A per-bit audit that
  // ignored this would report all six missing on a server where it can in fact do anything.
  assertEquals(missingPermissions(DISCORD_PERMISSION_BITS.ADMINISTRATOR), []);
  assertEquals(hasAdministrator(DISCORD_PERMISSION_BITS.ADMINISTRATOR), true);
  assertEquals(hasAdministrator(requiredPermissionsBits()), false);
});

Deno.test("missingPermissions: a partial set names only what is absent", () => {
  // The realistic misconfiguration: everything but Manage Roles, because the server owner ticked
  // the read/write boxes and balked at the role box.
  const granted = requiredPermissionsBits() & ~DISCORD_PERMISSION_BITS.MANAGE_ROLES;
  assertEquals(missingPermissions(granted), ["Manage Roles"]);
});

Deno.test("missingPermissions: two absent permissions come back in declaration order", () => {
  const granted =
    requiredPermissionsBits() & ~DISCORD_PERMISSION_BITS.VIEW_CHANNEL & ~DISCORD_PERMISSION_BITS.MANAGE_CHANNELS;
  assertEquals(missingPermissions(granted), ["View Channels", "Manage Channels"]);
});

Deno.test("missingPermissions: unrelated permissions do not satisfy the requirement", () => {
  // Ban Members (1 << 2) plus Manage Guild (1 << 5): a generous-looking bitfield that grants none
  // of what Pawtograder needs.
  assertEquals(missingPermissions((1n << 2n) | (1n << 5n)), ALL_LABELS);
});

Deno.test("parsePermissionBits: reads Discord's decimal strings, and fails closed", () => {
  assertEquals(parsePermissionBits("268435456"), 268435456n);
  assertEquals(parsePermissionBits(1024), 1024n);
  assertEquals(parsePermissionBits(8n), 8n);
  // A field past 2^53, which is why the module uses BigInt at all.
  assertEquals(parsePermissionBits("140737488355328"), 140737488355328n);
  // Unreadable must never mean "has everything".
  assertEquals(parsePermissionBits(null), 0n);
  assertEquals(parsePermissionBits(undefined), 0n);
  assertEquals(parsePermissionBits(""), 0n);
  assertEquals(parsePermissionBits("not-a-number"), 0n);
});

Deno.test("effectivePermissions: unions the roles the member holds", () => {
  const bits = effectivePermissions({
    guildRoles: [
      { id: "r1", permissions: String(DISCORD_PERMISSION_BITS.VIEW_CHANNEL) },
      { id: "r2", permissions: String(DISCORD_PERMISSION_BITS.MANAGE_ROLES) },
      { id: "r3", permissions: String(DISCORD_PERMISSION_BITS.ADMINISTRATOR) }
    ],
    memberRoleIds: ["r1", "r2"]
  });
  assertEquals(bits, DISCORD_PERMISSION_BITS.VIEW_CHANNEL | DISCORD_PERMISSION_BITS.MANAGE_ROLES);
  // r3 is not held, so Administrator must not leak in.
  assertEquals(hasAdministrator(bits), false);
});

Deno.test("effectivePermissions: @everyone counts even though it is not in member.roles", () => {
  // @everyone's role id IS the guild id, and Discord never lists it in a member's roles array. On
  // plenty of servers @everyone is what actually grants View Channel and Send Messages.
  const guildRoles = [
    { id: "guild-1", name: "@everyone", permissions: String(DISCORD_PERMISSION_BITS.VIEW_CHANNEL) },
    { id: "bot-role", permissions: String(DISCORD_PERMISSION_BITS.MANAGE_ROLES) }
  ];
  assertEquals(
    effectivePermissions({ guildRoles, memberRoleIds: ["bot-role"], guildId: "guild-1" }),
    DISCORD_PERMISSION_BITS.VIEW_CHANNEL | DISCORD_PERMISSION_BITS.MANAGE_ROLES
  );
  // Without the guild id the baseline is dropped and the audit under-reports.
  assertEquals(effectivePermissions({ guildRoles, memberRoleIds: ["bot-role"] }), DISCORD_PERMISSION_BITS.MANAGE_ROLES);
});

Deno.test("highestRolePosition: takes the max over held roles, floor 0 for @everyone", () => {
  const guildRoles = [
    { id: "low", position: 2 },
    { id: "high", position: 9 },
    { id: "highest-but-not-held", position: 20 }
  ];
  assertEquals(highestRolePosition({ guildRoles, memberRoleIds: ["low", "high"] }), 9);
  assertEquals(highestRolePosition({ guildRoles, memberRoleIds: [] }), 0);
  // A role payload missing `position` must not become NaN and poison the comparison.
  assertEquals(highestRolePosition({ guildRoles: [{ id: "r", position: null }], memberRoleIds: ["r"] }), 0);
});

Deno.test("canManageRoles: a bot above every class role can manage them", () => {
  assertEquals(canManageRoles({ botHighestPosition: 10, classRolePositions: [1, 2, 9] }), true);
});

Deno.test("canManageRoles: equal position is NOT enough", () => {
  // The subtle one. Discord's rule is strict inequality: the target role must be BELOW the acting
  // member's highest role. A role at exactly the bot's position fails, and fails as
  // `50013 Missing Permissions` -- the same code as not holding Manage Roles at all -- so a `>=`
  // slip here reports a healthy install for a server where no role assignment can ever succeed.
  assertEquals(canManageRoles({ botHighestPosition: 5, classRolePositions: [5] }), false);
  assertEquals(canManageRoles({ botHighestPosition: 5, classRolePositions: [1, 5] }), false);
});

Deno.test("canManageRoles: one role above the bot blocks the whole class", () => {
  // Instructors reorder roles in the server settings drag-and-drop and move one class role above
  // the bot without realising it. Everything else keeps working; that one role stops being
  // assignable.
  assertEquals(canManageRoles({ botHighestPosition: 4, classRolePositions: [1, 2, 3, 7] }), false);
});

Deno.test("canManageRoles: a bot below every class role cannot manage any", () => {
  assertEquals(canManageRoles({ botHighestPosition: 1, classRolePositions: [3, 4, 5] }), false);
});

Deno.test("canManageRoles: no class roles yet is not a problem", () => {
  // Nothing exists to be blocked. Reporting a failure here would flag every server the instant the
  // bot is invited, before any roles have been created.
  assertEquals(canManageRoles({ botHighestPosition: 0, classRolePositions: [] }), true);
  assertEquals(canManageRoles({ botHighestPosition: 7, classRolePositions: [] }), true);
});

Deno.test("canManageRoles: a bot left at @everyone (position 0) can manage nothing real", () => {
  assertEquals(canManageRoles({ botHighestPosition: 0, classRolePositions: [1] }), false);
});

Deno.test("botInstallUrl: no guild yet leaves the server picker enabled", () => {
  const url = new URL(botInstallUrl({ applicationId: "123456" }));
  assertEquals(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
  assertEquals(url.searchParams.get("client_id"), "123456");
  assertEquals(url.searchParams.get("scope"), "bot applications.commands");
  assertEquals(url.searchParams.get("permissions"), requiredPermissionsBits().toString());
  assertEquals(url.searchParams.get("guild_id"), null);
  assertEquals(url.searchParams.get("disable_guild_select"), null);
});

Deno.test("botInstallUrl: a known guild pins the consent screen to it", () => {
  const url = new URL(botInstallUrl({ applicationId: "123456", guildId: "987654321" }));
  assertEquals(url.searchParams.get("guild_id"), "987654321");
  assertEquals(url.searchParams.get("disable_guild_select"), "true");
});

Deno.test("botInstallUrl: stays on discord.com, which is not the API base", () => {
  // The API base is overridable so REST calls can be pointed at a mock. This link is handed to a
  // human in a browser and a mock has no consent screen, so it must not follow that override.
  assertEquals(botInstallUrl({ applicationId: "1" }).startsWith("https://discord.com/oauth2/authorize?"), true);
});
