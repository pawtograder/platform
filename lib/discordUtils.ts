/**
 * Discord utility functions for deep linking and message management
 */

import { Database } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Generate a Discord message deep link URL
 */
export function getDiscordMessageUrl(serverId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${serverId}/${channelId}/${messageId}`;
}

/**
 * Get Discord message URL for a help request or regrade request
 * Returns null if no Discord message exists
 */
export async function getDiscordMessageUrlForResource(
  supabase: SupabaseClient<Database>,
  classId: number,
  resourceType: "help_request" | "regrade_request",
  resourceId: number
): Promise<string | null> {
  // Get Discord message info
  const { data: message, error } = await supabase
    .from("discord_messages")
    .select("discord_message_id, discord_channel_id, class_id")
    .eq("class_id", classId)
    .eq("resource_type", resourceType)
    .eq("resource_id", resourceId)
    .maybeSingle();

  if (error || !message) {
    return null;
  }

  // Get Discord server ID from class
  const { data: classData } = await supabase
    .from("classes")
    .select("discord_server_id")
    .eq("id", classId)
    .maybeSingle();

  if (!classData?.discord_server_id) {
    return null;
  }

  return getDiscordMessageUrl(classData.discord_server_id, message.discord_channel_id, message.discord_message_id);
}
