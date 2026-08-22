/**
 * Checks whether the Pawtograder Discord bot is installed in a class's server and can actually do
 * its job there. The Discord counterpart of github-check-app-installation.
 *
 * Installation is necessary but not sufficient, which is why this reports several signals rather
 * than a boolean. A bot can be present in a guild and still fail every operation because it was
 * invited with a hand-edited permission set, because somebody later dragged its role below the class
 * roles in the server settings, because somebody deleted a class role outright and left Pawtograder
 * holding a dead snowflake, or because a per-channel overwrite takes back a permission the server
 * grants. Each surfaces downstream as a bare 403 or 404 from an unrelated feature -- roles silently
 * not assigned, channels not created, invites refused -- so the point of this function is to name the
 * cause before an instructor spends a term wondering why the roster never syncs.
 *
 * The last of those is why this reads the channel list as well as the roles. Discord resolves
 * permissions in two layers, and the guild-level layer is the only one an audit of role bitfields can
 * see: a server can grant Send Messages everywhere and deny it in `#general`, or deny Create Invite
 * in its text channels and make enrollment impossible, while every server-level signal here stays
 * clean. Those answers are `channel_permission_problems`, `missing_tracked_channel_ids` and
 * `can_create_invites`, kept apart from `missing_permissions` because their fix is editing one
 * channel's permissions (or re-syncing a channel that is gone), not re-authorizing the bot.
 *
 * Request:  { class_id: number }
 * Response: see CheckBotInstallationResponse
 *
 * Authorization: instructor OR grader in `class_id`. Read-only, and the Discord settings page admits
 * graders and renders this panel for them with the management controls disabled -- gating it to
 * instructors meant every grader saw "Could not check the Discord bot installation" instead of the
 * diagnosis the page exists to show. Installing, claiming and disconnecting remain instructor-only;
 * those are mutations and live in separate routes.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { discordBotGet, isTransientDiscordStatus } from "../_shared/DiscordBotRest.ts";
import { DISCORD_UNKNOWN_GUILD, DISCORD_MISSING_ACCESS } from "../_shared/DiscordErrorClassification.ts";
import { MAX_INVITE_CHANNEL_ATTEMPTS, inviteCandidateChannels } from "../_shared/DiscordInviteChannels.ts";
import {
  DISCORD_PERMISSION_BITS,
  botInstallUrl,
  canManageRoles,
  channelPermissions,
  effectivePermissions,
  grantsChannelPermission,
  highestRolePosition,
  missingChannelPermissions,
  missingPermissions,
  type DiscordPermissionOverwriteLike,
  type DiscordRoleLike
} from "../_shared/DiscordPermissions.ts";
import {
  NotFoundError,
  SecurityError,
  UserVisibleError,
  assertUserIsInstructorOrGrader,
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
  /**
   * Human-readable labels of the required permissions the bot does not hold **at the server level**.
   *
   * Server-level only, deliberately. Discord resolves each channel's own overwrites on top of these,
   * and those are reported separately in `channel_permission_problems` and
   * `can_create_invites`. Folding a channel result in here would send an instructor to the
   * re-authorize button, which cannot fix a channel overwrite -- the two failures have different
   * remediations, so they stay different fields.
   */
  missing_permissions: string[];
  can_manage_class_roles: boolean;
  bot_role_position: number | null;
  highest_class_role_position: number | null;
  /**
   * Roles Pawtograder still tracks in `discord_roles` that no longer exist in the guild.
   *
   * Its own field rather than a term in `can_manage_class_roles`, which stays a statement about
   * permissions and hierarchy. A deleted role is a different failure with a different fix: every
   * later assignment of that snowflake 404s, and the surviving tracking row stops role creation from
   * replacing it, so the class needs the stale row cleared rather than the bot's permissions widened.
   */
  stale_class_role_ids: string[];
  /**
   * Tracked channels where the channel's own permission overwrites block an operation the bot needs.
   *
   * Empty on a guild whose channel list could not be read, which is why it is not the only new
   * signal: absence of a problem here is not proof of health unless the check reached the channels.
   */
  channel_permission_problems: ChannelPermissionProblem[];
  /**
   * Channels Pawtograder still tracks in `discord_channels` that the guild's channel list does not
   * return.
   *
   * "Missing" covers two states this API genuinely cannot tell apart: the channel was deleted, or an
   * overwrite denies the bot View Channel so Discord omits it. Both are reported here because both
   * have the same consequence -- every notification aimed at that channel fails -- and the same pair
   * of remediations (re-sync so a replacement is created, or grant the bot access to it).
   *
   * Its own field rather than a term in `channel_permission_problems`, which claims specifically that
   * an overwrite blocks an operation. That claim cannot be made about a channel whose overwrites were
   * never read. This mirrors `stale_class_role_ids`, which is the same problem for roles.
   *
   * Empty when the channel list could not be read at all: with no listing, every tracked channel
   * would look missing.
   */
  missing_tracked_channel_ids: string[];
  /**
   * False when no visible text channel permits Create Invite, so no student can be invited.
   *
   * The most severe of the channel-level answers and its own field for that reason: a guild where
   * every text channel denies Create Invite -- or that has no text channel at all -- cannot enroll
   * anybody, however complete its server-level permissions look.
   */
  can_create_invites: boolean;
  install_url: string;
};

/** One tracked channel the bot cannot work in, and what it is short of there. */
export type ChannelPermissionProblem = {
  channel_id: string;
  /** From the live guild channel list; null when Discord returned the channel without a name. */
  channel_name: string | null;
  /** Labels from `REQUIRED_CHANNEL_PERMISSIONS`, the same strings the server-level list uses. */
  missing: string[];
};

/** Shape of the bits of `GET /guilds/{id}` we read. */
type GuildResponse = { id?: string; name?: string };

/** Shape of the bits of `GET /guilds/{id}/members/@me` we read. */
type GuildMemberResponse = { roles?: string[]; user?: { id?: string } };

/** Shape of the bits of `GET /guilds/{id}/channels` we read. Overwrites arrive inline. */
type GuildChannelResponse = {
  id?: string;
  name?: string | null;
  type?: number;
  permission_overwrites?: DiscordPermissionOverwriteLike[];
};

/**
 * Discord's channel `type` for a plain text channel.
 *
 * Used only as the default for a channel whose payload omitted `type`, since everything the worker
 * tracks is a channel it created. Which channels an INVITE can be made in is not decided here --
 * `inviteCandidateChannels` decides that, and it is the same function the invite path uses, so this
 * check cannot report a capacity the runtime does not have or deny one it does.
 */
const CHANNEL_TYPE_TEXT = 0;

/**
 * The channel types a message can be posted to: text, announcement, forum.
 *
 * Categories and voice channels are excluded because Send Messages is not a question you can ask of
 * them; a tracked category showing up as "cannot post" would be a false positive with no fix.
 */
const MESSAGEABLE_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5, 15]);

/**
 * Resolve every visible channel for the bot and pick out the two answers worth reporting.
 *
 * `GET /guilds/{id}/channels` carries each channel's `permission_overwrites` inline, so the whole
 * audit costs one request rather than one per channel. The list contains only the channels the bot can
 * see, which is itself a fact: a channel whose overwrites deny View Channel is absent from it
 * entirely, indistinguishable from a channel that was deleted.
 *
 * Three different questions, deliberately answered separately:
 *
 *   - Which of the class's TRACKED channels can the bot not work in? Those are the ones Pawtograder
 *     posts to, so an overwrite there silently drops notifications and digests.
 *   - Which tracked channels are not in the listing at all? Either somebody deleted one, or an
 *     overwrite hid it -- the API gives no way to tell those apart, and the remediation covers both.
 *   - Can an invite be created? Invites are the enrollment path, and one usable channel is enough --
 *     but only within the same budget the invite path spends. The candidate set and its order come
 *     from `inviteCandidateChannels`, the same function the invite path itself uses, and the same
 *     `MAX_INVITE_CHANNEL_ATTEMPTS` cap is applied to it: computing either from a private idea of what
 *     counts as usable is how a check ends up disagreeing with the code it is checking.
 */
function auditChannels(args: {
  channels: readonly GuildChannelResponse[];
  guildRoles: readonly DiscordRoleLike[];
  memberRoleIds: readonly string[];
  guildId: string;
  botUserId: string | null;
  trackedChannelIds: ReadonlySet<string>;
}): { problems: ChannelPermissionProblem[]; canCreateInvites: boolean; missingTrackedChannelIds: string[] } {
  const visible = args.channels.filter((channel): channel is GuildChannelResponse & { id: string } => {
    return typeof channel.id === "string" && channel.id !== "";
  });
  const byId = new Map(visible.map((channel) => [channel.id, channel]));

  // The channel's own overwrites and nothing else -- no walk up to `parent_id`. That is Discord's
  // documented algorithm, and a synced category reaches its children by having its overwrite set
  // COPIED onto them, so a synced child's list is already complete. Layering the category underneath
  // used to invent permissions for an UNSYNCED child: a category-level allow the child had dropped
  // came back out as granted, and this check would then report an operation as permitted that Discord
  // answers 403 to. See the note on `channelPermissions`.
  const resolve = (channel: GuildChannelResponse & { id: string }): bigint =>
    channelPermissions({
      guildRoles: args.guildRoles,
      memberRoleIds: args.memberRoleIds,
      guildId: args.guildId,
      memberUserId: args.botUserId,
      channelOverwrites: channel.permission_overwrites
    });

  const problems: ChannelPermissionProblem[] = [];
  for (const channel of visible) {
    if (!args.trackedChannelIds.has(channel.id)) continue;
    // An absent `type` is treated as text: everything the worker tracks is a channel it created, and
    // reading a truncated payload as "not messageable" would drop the check silently.
    if (!MESSAGEABLE_CHANNEL_TYPES.has(channel.type ?? CHANNEL_TYPE_TEXT)) continue;
    const missing = missingChannelPermissions(resolve(channel));
    if (missing.length === 0) continue;
    problems.push({ channel_id: channel.id, channel_name: channel.name ?? null, missing });
  }

  // A tracked channel that is not in the listing at all. Discord omits a channel the bot cannot see
  // exactly as it omits one that was deleted, so this cannot say which -- and it does not try to. It
  // is a separate answer from `problems` for that reason: the claim there is "an overwrite blocks
  // this", which cannot be made about overwrites that were never read.
  const missingTrackedChannelIds = [...args.trackedChannelIds].filter((id) => !byId.has(id));

  // Capped exactly as the invite path caps itself. createGuildInvite slices the same ordered
  // candidates to MAX_INVITE_CHANNEL_ATTEMPTS, so a guild whose fifth candidate is the only one
  // permitting Create Invite reports `can_create_invites: true` from an uncapped scan and then has
  // every student fail with `cannot_invite`. This field's only consumer is a prediction of that path,
  // so it has to be the same prediction: same candidate order, same number of tries.
  const canCreateInvites = inviteCandidateChannels(visible)
    .slice(0, MAX_INVITE_CHANNEL_ATTEMPTS)
    .some((candidate) => {
      const channel = byId.get(candidate.id);
      return channel ? grantsChannelPermission(resolve(channel), DISCORD_PERMISSION_BITS.CREATE_INSTANT_INVITE) : false;
    });

  return { problems, canCreateInvites, missingTrackedChannelIds };
}

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
  const { supabase } = await assertUserIsInstructorOrGrader(class_id, authHeader);

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
      stale_class_role_ids: [],
      channel_permission_problems: [],
      missing_tracked_channel_ids: [],
      // No guild, so no channel was asked about. Reported as false for the same reason
      // `can_manage_class_roles` is: nothing works yet, and the fix is the install button.
      can_create_invites: false,
      install_url: botInstallUrl({ applicationId })
    };
  }
  scope?.setTag("discord_guild_id", guildId);

  // claim_discord_guild() validates this shape, but it has only been the sole writer of the column
  // since migration 20260822130000. Anything a class carried over from the old free-text field is
  // unconstrained, and every value here is interpolated straight into a Discord REST path below -- so
  // a legacy value containing a slash or a query string would address an endpoint nobody intended.
  // Reported rather than silently ignored: an unusable server id is exactly the kind of thing the
  // instructor needs told, and re-running the install replaces it with a validated one.
  if (!/^\d{17,20}$/.test(guildId)) {
    scope?.setTag("error_type", "malformed_guild_id");
    throw new UserVisibleError(
      "This course's Discord server ID is not a valid Discord server ID. Re-connect the server to replace it.",
      409
    );
  }

  const notInstalled: CheckBotInstallationResponse = {
    installed: false,
    guild_id: guildId,
    guild_name: null,
    missing_permissions: [],
    can_manage_class_roles: false,
    bot_role_position: null,
    highest_class_role_position: null,
    // Empty rather than the tracked list: with the guild unreachable there is no live role list to
    // compare against, so every tracked role would look deleted.
    stale_class_role_ids: [],
    // Same reasoning: the channel list was never read, so there is nothing to report about it, and
    // every tracked channel would otherwise look deleted.
    channel_permission_problems: [],
    missing_tracked_channel_ids: [],
    can_create_invites: false,
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

  // The bot's own member object, the guild's role list, and the guild's channels. Discord does not
  // report a member's permissions on the member object -- only its role IDs -- so the first two are
  // both needed to compute anything. The third is what makes the per-channel answer possible, and it
  // is one request for the whole guild: `GET /guilds/{id}/channels` carries every channel's
  // `permission_overwrites` inline, so nothing here is per-channel fan-out. All three are independent.
  const [memberResult, rolesResult, channelsResult] = await Promise.all([
    discordBotGet(`/guilds/${guildId}/members/@me`, scope),
    discordBotGet(`/guilds/${guildId}/roles`, scope),
    discordBotGet(`/guilds/${guildId}/channels`, scope)
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

  // The channel list is handled apart from those two, because its failures mean different things.
  //
  //   - Transient (5xx / 429 / 401) is not evidence about the guild. Treating it as "no channel
  //     permits Create Invite" would report a healthy server as unable to enroll anybody, which is
  //     the same class of confident-wrong answer the guild fetch above refuses to give.
  //   - 403 / 50001 Missing Access and 404 / 10004 are facts, not errors: the bot cannot see this
  //     guild's channels. That is already named at the server level (View Channels appears in
  //     `missing_permissions`), so the check keeps its other findings and reports the channel layer as
  //     unreadable rather than throwing away the whole diagnosis.
  //
  // Anything else terminal is a shape nobody predicted, and is raised rather than guessed at.
  let channelsReadable = true;
  if (!channelsResult.ok) {
    if (isTransientDiscordStatus(channelsResult.status)) {
      throw new UserVisibleError(
        `Discord could not report the server's channels (HTTP ${channelsResult.status}). Try again.`,
        503
      );
    }
    const cannotSee =
      channelsResult.status === 403 ||
      channelsResult.code === DISCORD_MISSING_ACCESS ||
      channelsResult.status === 404 ||
      channelsResult.code === DISCORD_UNKNOWN_GUILD;
    if (!cannotSee) {
      throw new UserVisibleError(
        `Unexpected response from Discord while reading the server's channels (HTTP ${channelsResult.status})`,
        502
      );
    }
    channelsReadable = false;
    scope?.setTag("discord_channels_unreadable", String(channelsResult.status));
  }

  const member = (memberResult.data ?? {}) as GuildMemberResponse;
  const memberRoleIds = Array.isArray(member.roles) ? member.roles : [];
  // For the member-specific channel overwrites (`type: 1`), which outrank every role overwrite. Null
  // when the payload omitted it, in which case that layer is skipped rather than matched by guess.
  const botUserId = typeof member.user?.id === "string" ? member.user.id : null;
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
  // Rows naming a role that no longer exists in the guild are excluded from the hierarchy check
  // rather than counted at position 0: they cannot be dragged above the bot, and pinning them at the
  // floor would make an otherwise-fine server look manageable for the wrong reason.
  const classRolePositions = guildRoles
    .filter((role) => classRoleIds.has(role.id))
    .map((role) => (typeof role.position === "number" ? role.position : 0));
  const highestClassRolePosition = classRolePositions.length > 0 ? Math.max(...classRolePositions) : null;

  // Excluded from the hierarchy check, but reported: a role somebody deleted in Discord leaves its
  // `discord_roles` row behind, and that row is doing active harm. Every subsequent assignment uses a
  // snowflake Discord no longer knows, and the row's continued existence is what stops the ordinary
  // create-role path from making a replacement. Silently skipping it here is what let a class with a
  // broken role read as fully healthy.
  const liveRoleIds = new Set(guildRoles.map((role) => role.id));
  const staleClassRoleIds = [...classRoleIds].filter((id) => !liveRoleIds.has(id));
  if (staleClassRoleIds.length > 0) {
    scope?.setTag("stale_class_roles", String(staleClassRoleIds.length));
  }

  // The class's tracked channels, for the per-channel audit. Only the snowflake is stored, so the
  // name shown to the instructor comes from the live channel list.
  const { data: classChannels, error: channelsError } = await supabase
    .from("discord_channels")
    .select("discord_channel_id")
    .eq("class_id", class_id);
  if (channelsError) {
    throw new UserVisibleError(`Could not read the class's Discord channels: ${channelsError.message}`, 503);
  }

  const guildChannels: GuildChannelResponse[] =
    channelsReadable && Array.isArray(channelsResult.data) ? (channelsResult.data as GuildChannelResponse[]) : [];
  const {
    problems: channelPermissionProblems,
    canCreateInvites,
    missingTrackedChannelIds
  } = auditChannels({
    channels: guildChannels,
    guildRoles,
    memberRoleIds,
    guildId,
    botUserId,
    trackedChannelIds: new Set((classChannels ?? []).map((row) => row.discord_channel_id))
  });
  // Suppressed when the listing itself was unreadable: with no channels to compare against, every
  // tracked channel is absent from a list that does not exist, and reporting all of them as missing
  // would bury the real finding (View Channels, already named at the server level).
  const missingTrackedChannels = channelsReadable ? missingTrackedChannelIds : [];
  if (channelPermissionProblems.length > 0) {
    scope?.setTag("channel_permission_problems", String(channelPermissionProblems.length));
  }
  if (missingTrackedChannels.length > 0) {
    scope?.setTag("missing_tracked_channels", String(missingTrackedChannels.length));
  }
  if (!canCreateInvites) {
    scope?.setTag("discord_no_invite_channel", "true");
  }

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
    stale_class_role_ids: staleClassRoleIds,
    channel_permission_problems: channelPermissionProblems,
    missing_tracked_channel_ids: missingTrackedChannels,
    can_create_invites: canCreateInvites,
    // Still returned when installed: it is the "fix the permissions" link, since re-running the
    // OAuth flow on an existing guild is how a bot's permission set is widened.
    install_url: botInstallUrl({ applicationId, guildId })
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
