"use client";

import { Button, Icon } from "@chakra-ui/react";
import { Tooltip } from "@/components/ui/tooltip";
import { BsDiscord } from "react-icons/bs";
import { useMemo } from "react";
import { getDiscordChannelUrl } from "@/lib/discordUtils";
import { useCourse, useDiscordChannel } from "@/hooks/useCourseController";

interface DiscordChannelLinkProps {
  channelType: "office_hours";
  resourceId: number;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "outline" | "solid";
  tooltipText?: string;
}

/**
 * Component that displays a Discord link button to open a Discord channel
 * Only visible if a Discord channel exists for the resource
 * Uses cached discord_channels data from CourseController
 */
export default function DiscordChannelLink({
  channelType,
  resourceId,
  size = "sm",
  variant = "ghost",
  tooltipText = "Open Discord Channel"
}: DiscordChannelLinkProps) {
  const course = useCourse();
  const channel = useDiscordChannel(channelType, resourceId);

  const discordUrl = useMemo(() => {
    if (!channel || !course.discord_server_id) {
      return null;
    }
    return getDiscordChannelUrl(course.discord_server_id, channel.discord_channel_id);
  }, [channel, course.discord_server_id]);

  if (!discordUrl) {
    return null;
  }

  return (
    <Tooltip content={tooltipText} showArrow>
      <Button
        variant={variant}
        size={size}
        onClick={() => {
          window.open(discordUrl, "_blank");
        }}
        aria-label="Open Discord channel"
      >
        <Icon as={BsDiscord} />
      </Button>
    </Tooltip>
  );
}
