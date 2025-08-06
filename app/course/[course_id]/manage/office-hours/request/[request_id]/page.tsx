"use client";

import { useParams } from "next/navigation";
import type { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { BsClipboardCheck, BsClipboardCheckFill, BsCheckCircle, BsXCircle } from "react-icons/bs";
import { Icon, Skeleton, Text, Box, Badge, VStack, HStack } from "@chakra-ui/react";
import { Alert } from "@/components/ui/alert";
import HelpRequestChat from "@/components/help-queue/help-request-chat";
import { useHelpRequest, useConnectionStatus } from "@/hooks/useOfficeHoursRealtime";

/**
 * Component for displaying status-specific visual indicators and information
 * @param status - The current help request status
 * @returns JSX element with status-specific styling and content
 */
const HelpRequestStatusIndicator = ({ status }: { status: HelpRequest["status"] }) => {
  const statusConfig = {
    open: {
      colorPalette: "blue",
      icon: BsClipboardCheck,
      label: "Open",
      description: "Waiting for assistance"
    },
    in_progress: {
      colorPalette: "orange",
      icon: BsClipboardCheckFill,
      label: "In Progress",
      description: "Currently being assisted"
    },
    resolved: {
      colorPalette: "green",
      icon: BsCheckCircle,
      label: "Resolved",
      description: "Help request has been completed"
    },
    closed: {
      colorPalette: "gray",
      icon: BsXCircle,
      label: "Closed",
      description: "Help request has been closed"
    }
  };

  const config = statusConfig[status];

  return (
    <VStack gap={2} align="stretch">
      <HStack justify="space-between" align="center">
        <Badge colorPalette={config.colorPalette} size="lg" variant="solid">
          <HStack gap={1}>
            <Icon as={config.icon} />
            <Text fontWeight="semibold">{config.label}</Text>
          </HStack>
        </Badge>
      </HStack>
      <Text fontSize="sm" color="gray.600">
        {config.description}
      </Text>
      {(status === "resolved" || status === "closed") && (
        <Alert
          status={status === "resolved" ? "success" : "error"}
          title={
            status === "resolved"
              ? "This help request has been resolved. No further actions are available."
              : "This help request has been closed and is no longer active."
          }
        />
      )}
    </VStack>
  );
};

/**
 * Main page component for displaying and managing a help request
 * Shows different visual states based on request status
 * Uses real-time updates for help request data, messages, and staff actions
 * @returns JSX element for the help request page
 */
export default function HelpRequestPage() {
  const { request_id } = useParams();

  // Get help request data and connection status using individual hooks
  const request = useHelpRequest(Number(request_id));
  const { isConnected, connectionStatus, isLoading: realtimeLoading } = useConnectionStatus();

  if (realtimeLoading || !request) {
    return <Skeleton />;
  }

  return (
    <Box>
      {/* Connection Status Indicator */}
      {!isConnected && (
        <Alert status="warning" title="Real-time updates disconnected" mb={4}>
          Help request updates may not appear immediately. Connection status: {connectionStatus?.overall}
        </Alert>
      )}

      <Box transition="opacity 0.2s ease-in-out">
        <VStack gap={4} align="stretch" mb={4}>
          <HStack justify="space-between" align="center">
            <HelpRequestStatusIndicator status={request.status} />
          </HStack>
        </VStack>

        <HelpRequestChat request={request} />
      </Box>
    </Box>
  );
}
