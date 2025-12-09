"use client";

import { Button, Icon } from "@chakra-ui/react";
import { Tooltip } from "@/components/ui/tooltip";
import { BsDiscord } from "react-icons/bs";
import { createBrowserClient } from "@supabase/ssr";
import { useEffect, useState } from "react";
import { getDiscordMessageUrlForResource } from "@/lib/discordUtils";

interface DiscordMessageLinkProps {
  classId: number;
  resourceType: "help_request" | "regrade_request";
  resourceId: number;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "outline" | "solid";
}

/**
 * Component that displays a Discord link button if a Discord message exists for the resource
 * Only visible to staff members
 */
export default function DiscordMessageLink({
  classId,
  resourceType,
  resourceId,
  size = "sm",
  variant = "ghost"
}: DiscordMessageLinkProps) {
  const [discordUrl, setDiscordUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDiscordUrl = async () => {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || "",
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
      );

      try {
        const url = await getDiscordMessageUrlForResource(supabase, classId, resourceType, resourceId);
        setDiscordUrl(url);
      } catch (error) {
        console.error("Failed to fetch Discord message URL:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchDiscordUrl();
  }, [classId, resourceType, resourceId]);

  if (loading || !discordUrl) {
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
