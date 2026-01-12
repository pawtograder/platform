"use client";

import { Button, Icon } from "@chakra-ui/react";
import { Tooltip } from "@/components/ui/tooltip";
import { BsDiscord } from "react-icons/bs";
import { useMemo } from "react";
import { getDiscordMessageUrl } from "@/lib/discordUtils";
import { useCourse, useDiscordMessage } from "@/hooks/useCourseController";

interface DiscordDiscussionMessageLinkProps {
  /** The discussion thread ID to look up the Discord message for */
  threadId: number;
  /** Button size */
  size?: "sm" | "md" | "lg";
  /** Button variant */
  variant?: "ghost" | "outline" | "solid";
  /** Whether to show label text alongside the icon */
  showLabel?: boolean;
}

/**
 * Component that displays a Discord link button if a Discord message exists for a discussion thread.
 * Uses cached discord_messages data from CourseController.
 * Only shows for root threads that have been posted to Discord.
 */
export default function DiscordDiscussionMessageLink({
  threadId,
  size = "sm",
  variant = "ghost",
  showLabel = false
}: DiscordDiscussionMessageLinkProps) {
  const course = useCourse();
  // Note: 'discussion_thread' is added to discord_resource_type enum in migration
  // TypeScript types need to be regenerated for full type safety
  const message = useDiscordMessage("discussion_thread" as "help_request" | "regrade_request", threadId);

  const discordUrl = useMemo(() => {
    if (!message || !course?.discord_server_id) {
      return null;
    }
    return getDiscordMessageUrl(course.discord_server_id, message.discord_channel_id, message.discord_message_id);
  }, [message, course?.discord_server_id]);

  if (!discordUrl) {
    return null;
  }

  return (
    <Tooltip content="View this thread in Discord" showArrow>
      <Button
        variant={variant}
        size={size}
        colorPalette="purple"
        onClick={() => {
          window.open(discordUrl, "_blank", "noopener,noreferrer");
        }}
        aria-label="Open discussion thread in Discord"
      >
        <Icon as={BsDiscord} />
        {showLabel && " Discord"}
      </Button>
    </Tooltip>
  );
}
