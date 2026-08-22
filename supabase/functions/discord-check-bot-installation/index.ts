/**
 * Checks whether the Pawtograder Discord bot is installed in a class's server and can actually do
 * its job there. The Discord counterpart of github-check-app-installation.
 *
 * Installation is necessary but not sufficient, which is why this reports four things rather than a
 * boolean. A bot can be present in a guild and still fail every operation because it was invited
 * with a hand-edited permission set, or because somebody later dragged its role below the class
 * roles in the server settings. Both surface downstream as bare 403s from unrelated features --
 * roles silently not assigned, channels not created -- so the point of this function is to name the
 * cause before an instructor spends a term wondering why the roster never syncs.
 *
 * Request:  { class_id: number }
 * Response: see CheckBotInstallationResponse
 *
 * Authorization: caller must be an instructor in `class_id`.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { discordBotGet, isTransientDiscordStatus } from "../_shared/DiscordBotRest.ts";
import { DISCORD_UNKNOWN_GUILD, DISCORD_MISSING_ACCESS } from "../_shared/DiscordErrorClassification.ts";
import {
  DISCORD_PERMISSION_BITS,
  botInstallUrl,
  canManageRoles,
  effectivePermissions,
  highestRolePosition,
  missingPermissions,
  type DiscordRoleLike
} from "../_shared/DiscordPermissions.ts";
import {
  NotFoundError,
  SecurityError,
  UserVisibleError,
  assertUserIsInstructor,
  wrapRequestHandler
} from "../_shared/HandlerUtils.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";

type RequestBody = {
  class_id: number;
};

export type CheckBotInstallationResponse = {
  installed: boolean;
  guild_id: string | null;
  guild_name: string | null;
  missing_permissions: string[];
  can_manage_class_roles: boolean;
  bot_role_position: number | null;
  highest_class_role_position: number | null;
  install_url: string;
};

/** Shape of the bits of `GET /guilds/{id}` we read. */
type GuildResponse = { id?: string; name?: string };

/** Shape of the bits of `GET /guilds/{id}/members/@me` we read. */
type GuildMemberResponse = { roles?: string[] };

function resolveApplicationId(): string {
  const applicationId = Deno.env.get("DISCORD_APPLICATION_ID");
  if (!applicationId) {
    // Without it there is no install link to offer, and an install link is the only actionable part
    // of a negative answer, so a blank one would make the whole response useless.
    throw new UserVisibleError("Discord is not configured on this deployment (DISCORD_APPLICATION_ID is unset)", 500);
  }
  return applicationId;
}

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<CheckBotInstallationResponse> {
  const { class_id }: RequestBody = await req.json();
  scope?.setTag("function", "discord-check-bot-installation");
  if (!class_id) {
    throw new UserVisibleError("class_id is required", 400);
  }
  scope?.setTag("class_id", String(class_id));

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new SecurityError("Missing Authorization header");
  }
  const { supabase } = await assertUserIsInstructor(class_id, authHeader);

  const { data: classRow, error: classError } = await supabase
    .from("classes")
    .select("discord_server_id")
    .eq("id", class_id)
    .maybeSingle();
  if (classError) {
    throw new UserVisibleError(`Could not read the class's Discord settings: ${classError.message}`, 503);
  }
  if (!classRow) {
    throw new NotFoundError(`Class ${class_id} not found`);
  }

  const applicationId = resolveApplicationId();
  const guildId = classRow.discord_server_id;

  // No server configured yet. This is the ordinary starting state for every class, not an error --
  // the instructor has simply not installed the bot, and the actionable answer is the install URL.
  // `missing_permissions` is empty rather than the full required list: with no guild there is
  // nothing that has failed to grant anything, and listing all six here would render as a wall of
  // red next to an "install" button that has not been pressed.
  if (!guildId) {
    return {
      installed: false,
      guild_id: null,
      guild_name: null,
      missing_permissions: [],
      can_manage_class_roles: false,
      bot_role_position: null,
      highest_class_role_position: null,
      install_url: botInstallUrl({ applicationId })
    };
  }
  scope?.setTag("discord_guild_id", guildId);

  const notInstalled: CheckBotInstallationResponse = {
    installed: false,
    guild_id: guildId,
    guild_name: null,
    missing_permissions: [],
    can_manage_class_roles: false,
    bot_role_position: null,
    highest_class_role_position: null,
    // Pinned to the configured guild so the consent screen cannot be pointed at a different server.
    install_url: botInstallUrl({ applicationId, guildId })
  };

  const guildResult = await discordBotGet(`/guilds/${guildId}`, scope);
  if (!guildResult.ok) {
    // A transient failure must never be reported as "not installed": that answer is confident,
    // wrong, and the remediation it implies is re-inviting a bot that is already there.
    if (isTransientDiscordStatus(guildResult.status)) {
      throw new UserVisibleError(
        `Discord could not be reached to check the bot installation (HTTP ${guildResult.status}). Try again.`,
        503
      );
    }
    // 404, or 10004 Unknown Guild on any status: the bot is not a member of this guild, or the
    // configured ID names a server that does not exist.
    //
    // 403 / 50001 Missing Access is folded in here too. It means the bot cannot see the guild at
    // all, which is indistinguishable from absence to the instructor and has the same fix -- invite
    // it again with the required permissions.
    if (
      guildResult.status === 404 ||
      guildResult.code === DISCORD_UNKNOWN_GUILD ||
      guildResult.status === 403 ||
      guildResult.code === DISCORD_MISSING_ACCESS
    ) {
      return notInstalled;
    }
    throw new UserVisibleError(
      `Unexpected response from Discord while checking the bot installation (HTTP ${guildResult.status})`,
      502
    );
  }

  const guild = (guildResult.data ?? {}) as GuildResponse;

  // The bot's own member object and the guild's role list. Discord does not report a member's
  // permissions on the member object -- only its role IDs -- so both are needed to compute anything,
  // and they are independent requests.
  const [memberResult, rolesResult] = await Promise.all([
    discordBotGet(`/guilds/${guildId}/members/@me`, scope),
    discordBotGet(`/guilds/${guildId}/roles`, scope)
  ]);

  // Past this point the guild is confirmed reachable, so a failure here is not evidence about the
  // installation. Falling back to zeros would report every permission missing on a healthy server,
  // which is worse than an error the instructor can retry.
  for (const [label, result] of [
    ["the bot's guild membership", memberResult],
    ["the server's roles", rolesResult]
  ] as const) {
    if (!result.ok) {
      const status = isTransientDiscordStatus(result.status) ? 503 : 502;
      throw new UserVisibleError(`Discord could not report ${label} (HTTP ${result.status})`, status);
    }
  }

  const member = (memberResult.data ?? {}) as GuildMemberResponse;
  const memberRoleIds = Array.isArray(member.roles) ? member.roles : [];
  const guildRoles: DiscordRoleLike[] = Array.isArray(rolesResult.data) ? (rolesResult.data as DiscordRoleLike[]) : [];

  const granted = effectivePermissions({ guildRoles, memberRoleIds, guildId });
  const missing = missingPermissions(granted);
  const botPosition = highestRolePosition({ guildRoles, memberRoleIds });

  // The class's roles, as Pawtograder recorded them. `discord_roles` stores only the snowflake, not
  // the position -- positions change every time somebody reorders roles in the Discord UI, so the
  // live guild role list is the only trustworthy source for them.
  const { data: classRoles, error: rolesError } = await supabase
    .from("discord_roles")
    .select("discord_role_id")
    .eq("class_id", class_id);
  if (rolesError) {
    throw new UserVisibleError(`Could not read the class's Discord roles: ${rolesError.message}`, 503);
  }

  const classRoleIds = new Set((classRoles ?? []).map((r) => r.discord_role_id));
  // Rows naming a role that no longer exists in the guild are skipped rather than counted at
  // position 0: somebody deleted the role in Discord, so it cannot block anything, and pinning it at
  // the floor would make an otherwise-fine server look manageable for the wrong reason.
  const classRolePositions = guildRoles
    .filter((role) => classRoleIds.has(role.id))
    .map((role) => (typeof role.position === "number" ? role.position : 0));
  const highestClassRolePosition = classRolePositions.length > 0 ? Math.max(...classRolePositions) : null;

  // Both halves of Discord's rule, because a role assignment needs both and the caller wants to know
  // whether it will work. Which half failed is still recoverable from the response: an empty
  // `missing_permissions` with `can_manage_class_roles: false` is the hierarchy problem, and the two
  // positions are the evidence for it.
  const hasManageRoles = (granted & DISCORD_PERMISSION_BITS.MANAGE_ROLES) !== 0n;
  const hasAdmin = (granted & DISCORD_PERMISSION_BITS.ADMINISTRATOR) !== 0n;
  const canManageClassRoles =
    (hasManageRoles || hasAdmin) && canManageRoles({ botHighestPosition: botPosition, classRolePositions });

  return {
    installed: true,
    guild_id: guildId,
    guild_name: guild.name ?? null,
    missing_permissions: missing,
    can_manage_class_roles: canManageClassRoles,
    bot_role_position: botPosition,
    highest_class_role_position: highestClassRolePosition,
    // Still returned when installed: it is the "fix the permissions" link, since re-running the
    // OAuth flow on an existing guild is how a bot's permission set is widened.
    install_url: botInstallUrl({ applicationId, guildId })
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
