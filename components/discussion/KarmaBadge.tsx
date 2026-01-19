"use client";

import { Badge, HStack, Icon, Text } from "@chakra-ui/react";
import { FaHeart, FaSeedling, FaStar, FaTrophy } from "react-icons/fa";
import { Tooltip } from "@/components/ui/tooltip";

type KarmaBadgeProps = {
  karma: number;
  size?: "sm" | "md" | "lg";
};

/**
 * KarmaBadge component displays a user's discussion karma
 * - 0 karma: Green sprout icon (like Discord's "new member")
 * - 1-10 karma: Heart with count
 * - 11-49 karma: Star with count (blue)
 * - 50+ karma: Trophy with count (gold)
 */
export function KarmaBadge({ karma, size = "sm" }: KarmaBadgeProps) {
  const tooltipContent = `${karma} ${karma === 1 ? "like" : "likes"} received`;

  if (karma === 0) {
    return (
      <Tooltip content={tooltipContent}>
        <Badge colorPalette="green" variant="subtle" size={size}>
          <Icon as={FaSeedling} boxSize="3" />
        </Badge>
      </Tooltip>
    );
  }

  if (karma >= 50) {
    return (
      <Tooltip content={tooltipContent}>
        <Badge colorPalette="yellow" variant="subtle" size={size}>
          <HStack gap="1">
            <Icon as={FaTrophy} boxSize="3" />
            <Text fontSize="xs">{karma}</Text>
          </HStack>
        </Badge>
      </Tooltip>
    );
  }

  if (karma >= 11) {
    return (
      <Tooltip content={tooltipContent}>
        <Badge colorPalette="blue" variant="subtle" size={size}>
          <HStack gap="1">
            <Icon as={FaStar} boxSize="3" />
            <Text fontSize="xs">{karma}</Text>
          </HStack>
        </Badge>
      </Tooltip>
    );
  }

  // 1-10 karma
  return (
    <Tooltip content={tooltipContent}>
      <Badge variant="subtle" size={size}>
        <HStack gap="1">
          <Icon as={FaHeart} boxSize="3" />
          <Text fontSize="xs">{karma}</Text>
        </HStack>
      </Badge>
    </Tooltip>
  );
}
