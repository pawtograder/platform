"use client";

import HelpRequestChat from "@/components/help-queue/help-request-chat";
import { Alert } from "@/components/ui/alert";
import { useCourseController } from "@/hooks/useCourseController";
import { useHelpRequest } from "@/hooks/useOfficeHoursRealtime";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, HStack, Icon, Skeleton, Text, VStack, Flex, useBreakpointValue } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BsCheckCircle, BsClipboardCheck, BsClipboardCheckFill, BsXCircle } from "react-icons/bs";
import { HelpRequestSidebar } from "@/components/help-queue/help-request-sidebar";

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
  const { request_id, queue_id } = useParams();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const isDesktop = useBreakpointValue({ base: false, lg: true }) ?? false;
  const showFullSidebar = isDesktop && sidebarOpen;

  // Get help request data and connection status using individual hooks
  const request = useHelpRequest(Number(request_id));
  const course = useCourseController();

  const title = (() => {
    try {
      const c = course.course; // may throw until loaded
      return `${c.course_title || c.name} - Office Hours #${request_id} - Pawtograder`;
    } catch {
      return undefined;
    }
  })();

  useEffect(() => {
    if (title) {
      document.title = title;
    }
  }, [title]);

  if (!request) {
    return <Skeleton />;
  }

  return (
    <Flex direction="row" gap={{ base: 3, lg: 6 }} align="stretch">
      <Box
        flex={{ lg: showFullSidebar ? 4 : "unset" }}
        width={{ base: "52px", lg: showFullSidebar ? "auto" : "52px" }}
        minW={0}
      >
        <HelpRequestSidebar
          requestId={Number(request_id)}
          isOpen={showFullSidebar}
          onToggle={() => {
            if (!isDesktop) return;
            setSidebarOpen((v) => !v);
          }}
          queueId={queue_id ? Number(queue_id) : request.help_queue}
          isManageMode={true}
        />
      </Box>
      <Box flex={{ lg: 8 }} minW={0}>
        <Box>
          <Box transition="opacity 0.2s ease-in-out">
            <VStack gap={4} align="stretch" mb={4}>
              <HStack justify="space-between" align="center">
                <HelpRequestStatusIndicator status={request.status} />
              </HStack>
            </VStack>
            <HelpRequestChat request_id={request.id} />
          </Box>
        </Box>
      </Box>
    </Flex>
  );
}
