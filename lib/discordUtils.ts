/**
 * Discord utility functions for deep linking
 *
 * Data fetching is handled by CourseController's discordChannels and discordMessages TableControllers.
 * Use the useDiscordChannel and useDiscordMessage hooks to get cached data.
 */

/**
 * Generate a Discord message deep link URL
 */
export function getDiscordMessageUrl(serverId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${serverId}/${channelId}/${messageId}`;
}

/**
 * Generate a Discord channel deep link URL
 */
export function getDiscordChannelUrl(serverId: string, channelId: string): string {
  return `https://discord.com/channels/${serverId}/${channelId}`;
}
