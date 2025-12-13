"use client";

import { Button, Icon } from "@chakra-ui/react";
import { Tooltip } from "@/components/ui/tooltip";
import { BsDiscord } from "react-icons/bs";
import { useMemo } from "react";
import { getDiscordMessageUrl } from "@/lib/discordUtils";
import { useCourse, useDiscordMessage } from "@/hooks/useCourseController";

interface DiscordMessageLinkProps {
  resourceType: "help_request" | "regrade_request";
  resourceId: number;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "outline" | "solid";
}

/**
 * Component that displays a Discord link button if a Discord message exists for the resource
 * Only visible to staff members
 * Uses cached discord_messages data from CourseController
 */
export default function DiscordMessageLink({
  resourceType,
  resourceId,
  size = "sm",
  variant = "ghost"
}: DiscordMessageLinkProps) {
  const course = useCourse();
  const message = useDiscordMessage(resourceType, resourceId);

  const discordUrl = useMemo(() => {
    if (!message || !course.discord_server_id) {
      return null;
    }
    return getDiscordMessageUrl(course.discord_server_id, message.discord_channel_id, message.discord_message_id);
  }, [message, course.discord_server_id]);

  if (!discordUrl) {
    return null;
  }

  return (
    <Tooltip content="Open in Discord" showArrow>
      <Button
        variant={variant}
        size={size}
        onClick={() => {
          window.open(discordUrl, "_blank");
        }}
        aria-label="Open Discord message"
      >
        <Icon as={BsDiscord} />
      </Button>
    </Tooltip>
  );
}
