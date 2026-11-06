"use client";

import { escalationBadgeLabel } from "@/lib/helpRequestEscalation";
import { Badge, Icon } from "@chakra-ui/react";
import { BsArrowUpCircleFill } from "react-icons/bs";

/** "Escalated" flag, with a count once a ticket has been escalated more than once. */
export function EscalationBadge({
  escalationCount,
  size = "sm"
}: {
  escalationCount: number;
  size?: "xs" | "sm" | "md";
}) {
  const label = escalationBadgeLabel(escalationCount);
  if (!label) return null;
  return (
    <Badge colorPalette="purple" variant="solid" size={size} flexShrink={0}>
      <Icon as={BsArrowUpCircleFill} />
      {label}
    </Badge>
  );
}
