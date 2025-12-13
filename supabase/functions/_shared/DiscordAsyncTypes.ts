export type DiscordAsyncMethod =
  | "send_message"
  | "update_message"
  | "create_channel"
  | "delete_channel"
  | "create_role"
  | "delete_role"
  | "add_member_role"
  | "remove_member_role"
  | "add_guild_member"
  | "register_commands"
  | "batch_role_sync";

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
  content?: string;
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

export type AddGuildMemberArgs = {
  guild_id: string;
  user_id: string;
  access_token: string; // User's OAuth access token with guilds.join scope
  nick?: string;
  roles?: string[]; // Role IDs to assign
  mute?: boolean;
  deaf?: boolean;
};

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
  | AddGuildMemberArgs
  | RegisterCommandsArgs
  | BatchRoleSyncArgs;

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
  resource_type?: "help_request" | "regrade_request"; // For tracking in discord_messages table
  resource_id?: number; // For tracking in discord_messages table
  // For channel tracking (create_channel method)
  channel_type?: "general" | "assignment" | "lab" | "office_hours" | "regrades" | "scheduling" | "operations"; // For tracking in discord_channels table
  // For role tracking (create_role method)
  role_type?: "student" | "grader" | "instructor"; // For tracking in discord_roles table
};
