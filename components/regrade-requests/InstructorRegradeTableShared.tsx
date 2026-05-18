"use client";

import type { RegradeStatus } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, HStack, Icon, Link as ChakraLink, Tag, Text } from "@chakra-ui/react";
import type { LucideIcon } from "lucide-react";
import { AlertCircle, ArrowUp, CheckCircle, Clock, XCircle } from "lucide-react";
import { FaCheck, FaExternalLinkAlt, FaTimes } from "react-icons/fa";

export const statusConfig: Record<
  RegradeStatus,
  {
    colorPalette: string;
    icon: LucideIcon;
    label: string;
  }
> = {
  draft: {
    colorPalette: "gray",
    icon: Clock,
    label: "Draft"
  },
  opened: {
    colorPalette: "orange",
    icon: AlertCircle,
    label: "Pending"
  },
  resolved: {
    colorPalette: "blue",
    icon: CheckCircle,
    label: "Resolved"
  },
  escalated: {
    colorPalette: "red",
    icon: ArrowUp,
    label: "Escalated"
  },
  closed: {
    colorPalette: "gray",
    icon: XCircle,
    label: "Closed"
  }
};

export function StatusCell({ status }: { status: RegradeStatus }) {
  const config = statusConfig[status];
  const StatusIcon = config.icon;

  return (
    <Tag.Root colorPalette={config.colorPalette} variant="surface">
      <HStack gap={1}>
        <Icon as={StatusIcon} boxSize={3} />
        <Tag.Label>{config.label}</Tag.Label>
      </HStack>
    </Tag.Root>
  );
}

export function AppealGrantedCell({
  status,
  closedPoints,
  resolvedPoints
}: {
  status: RegradeStatus;
  closedPoints: number | null;
  resolvedPoints: number | null;
}) {
  const isAppealGranted =
    status === "closed" && closedPoints !== null && resolvedPoints !== null && closedPoints !== resolvedPoints;

  if (status !== "closed") {
    return <Text color="fg.muted">N/A</Text>;
  }

  return (
    <HStack gap={1}>
      <Icon as={isAppealGranted ? FaCheck : FaTimes} boxSize={3} color={isAppealGranted ? "green.500" : "red.500"} />
      <Text color={isAppealGranted ? "green.500" : "red.500"}>{isAppealGranted ? "Yes" : "No"}</Text>
    </HStack>
  );
}

/**
 * Opens the submission files view with the regrade request anchor (same deep link as notifications).
 */
export function RegradeRequestContextLink({
  courseId,
  assignmentId,
  submissionId,
  regradeRequestId
}: {
  courseId: number;
  assignmentId: number;
  submissionId: number;
  regradeRequestId: number;
}) {
  const href = `/course/${courseId}/assignments/${assignmentId}/submissions/${submissionId}/files#regrade-request-${regradeRequestId}`;

  return (
    <HStack>
      <Button variant="ghost" size="sm" asChild>
        <a href={href} target="_blank" rel="noopener noreferrer">
          <HStack gap={1}>
            <Text fontSize="sm">Open</Text>
            <Icon as={FaExternalLinkAlt} boxSize={3} />
          </HStack>
        </a>
      </Button>
    </HStack>
  );
}

export function StudentOrGroupLabel({
  assignmentGroupsMembers,
  profileName
}: {
  assignmentGroupsMembers?: { profiles: { name: string | null } | null }[] | null;
  profileName?: string | null;
}) {
  if (assignmentGroupsMembers?.length) {
    return (
      <Text>
        Group:{" "}
        {assignmentGroupsMembers
          .map((member) => member.profiles?.name)
          .filter(Boolean)
          .join(", ")}
      </Text>
    );
  }
  return <Text>{profileName || "Unknown"}</Text>;
}

export function AssignmentTitleCell({ title, href }: { title: string; href: string }) {
  return (
    <Box maxW="220px">
      <ChakraLink href={href} target="_blank" rel="noopener noreferrer" fontSize="sm" colorPalette="blue">
        {title}
      </ChakraLink>
    </Box>
  );
}
