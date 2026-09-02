export type DiscordAsyncMethod =
  | "send_message"
  | "update_message"
  | "create_channel"
  | "delete_channel"
  | "create_role"
  | "delete_role"
  | "add_member_role"
  | "remove_member_role"
  | "register_commands"
  | "batch_role_sync"
  | "delete_invite";

export type SendMessageArgs = {
  channel_id: string;
  content: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    fields?: Array<{
      name: string;
      value: string;
      inline?: boolean;
    }>;
    footer?: {
      text: string;
    };
    timestamp?: string;
  }>;
  allowed_mentions?: {
    users?: string[];
    roles?: string[];
  };
};

export type UpdateMessageArgs = {
  channel_id: string;
  message_id: string;
  allowed_mentions?: {
    users?: string[];
    roles?: string[];
  };
} & (
  | {
      content: string;
      embeds?: Array<{
        title?: string;
        description?: string;
        url?: string;
        color?: number;
        fields?: Array<{
          name: string;
          value: string;
          inline?: boolean;
        }>;
        footer?: {
          text: string;
        };
        timestamp?: string;
      }>;
    }
  | {
      embeds: Array<{
        title?: string;
        description?: string;
        url?: string;
        color?: number;
        fields?: Array<{
          name: string;
          value: string;
          inline?: boolean;
        }>;
        footer?: {
          text: string;
        };
        timestamp?: string;
      }>;
      content?: string;
    }
);

export type CreateChannelArgs = {
  guild_id: string;
  name: string;
  type: number; // 0 = text channel, 4 = category
  parent_id?: string; // category ID
  topic?: string;
  position?: number;
};

export type DeleteChannelArgs = {
  channel_id: string;
};

export type CreateRoleArgs = {
  guild_id: string;
  name: string;
  color?: number;
  hoist?: boolean; // Display members with this role separately
  mentionable?: boolean;
  permissions?: string; // Permission bitfield as string
};

export type DeleteRoleArgs = {
  guild_id: string;
  role_id: string;
};

export type AddMemberRoleArgs = {
  guild_id: string;
  user_id: string;
  role_id: string;
};

export type RemoveMemberRoleArgs = {
  guild_id: string;
  user_id: string;
  role_id: string;
};

/**
 * Revoke one invite, by code.
 *
 * Enqueued by clear_discord_tracking_for_class() when a class moves guilds, disconnects or is
 * archived. Invites are minted with `max_age = 604800` and `max_uses = 5`, and the partial uniqueness
 * index on classes.discord_server_id frees the released guild for another course to claim
 * immediately -- so an invite left live is a former student of one course walking into another
 * course's server, for up to seven days. The teardown is SQL and cannot call Discord, which is the
 * whole reason this method exists: the revocation has to be something SQL can ask for.
 *
 * `guild_id` is carried for logs and Sentry context only; `DELETE /invites/{code}` takes the code
 * alone. It is the guild the invite was minted INTO, read from discord_invites.guild_id rather than
 * from classes -- by the time the teardown runs, the class no longer names that guild.
 */
export type DeleteInviteArgs = {
  invite_code: string;
  guild_id?: string;
};

// There is no add_guild_member method. Adding a user to a guild over the REST API requires that
// user's OAuth token carrying the `guilds.join` scope, and linkDiscordAction requests only
// `identify email`, so the call could never have been made. Students join through an invite link
// instead, which is what createGuildInvite and the discord_invites table exist for.

// Args for registering slash commands with Discord
// No args needed - uses DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN from env
export type RegisterCommandsArgs = Record<string, never>;

// Args for batch role sync
// No args needed - queries database for users needing sync
export type BatchRoleSyncArgs = Record<string, never>;

export type DiscordAsyncArgs =
  | SendMessageArgs
  | UpdateMessageArgs
  | CreateChannelArgs
  | DeleteChannelArgs
  | CreateRoleArgs
  | DeleteRoleArgs
  | AddMemberRoleArgs
  | RemoveMemberRoleArgs
  | RegisterCommandsArgs
  | BatchRoleSyncArgs
  | DeleteInviteArgs;

export type DiscordAsyncEnvelope = {
  method: DiscordAsyncMethod;
  args: DiscordAsyncArgs;
  class_id?: number;
  debug_id?: string;
  log_id?: number;
  retry_count?: number;
  // For message tracking
  discord_message_id?: string; // For update_message, the message ID to update
  discord_channel_id?: string; // For send_message, store the channel ID
  resource_type?: "help_request" | "regrade_request" | "discussion_thread"; // For tracking in discord_messages table
  resource_id?: number; // For tracking in discord_messages table
  // For channel tracking (create_channel method)
  channel_type?: "general" | "assignment" | "lab" | "office_hours" | "regrades" | "scheduling" | "operations" | "forum"; // For tracking in discord_channels table
  // For role tracking (create_role method)
  role_type?: "student" | "grader" | "instructor"; // For tracking in discord_roles table
  // For email link generation (help requests)
  email_data?: {
    student_emails?: string | null; // Formatted as "Name <email>"
    assignee_email?: string | null;
    class_name?: string | null;
  };
};
