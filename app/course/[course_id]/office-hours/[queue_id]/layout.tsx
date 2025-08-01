"use client";

import { Box, Heading, VStack } from "@chakra-ui/react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import ModerationBanNotice from "@/components/ui/moderation-ban-notice";
import { useQueueData } from "@/hooks/useQueueData";
import { useHelpQueue } from "@/hooks/useOfficeHoursRealtime";

interface LayoutProps {
  children: React.ReactNode;
}

export default function QueueLayout({ children }: LayoutProps) {
  const { queue_id, course_id } = useParams();
  const pathname = usePathname();
  const helpQueue = useHelpQueue(Number(queue_id));

  const { queueRequests, userRequests, similarQuestions, resolvedRequests, isLoading, connectionStatus } =
    useQueueData({
      courseId: Number(course_id),
      queueId: Number(queue_id)
    });

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (connectionStatus?.overall === "disconnected") {
    return <div>Connection error. Please try refreshing the page.</div>;
  }

  if (!helpQueue) {
    return <div>Help queue not found.</div>;
  }

  const basePath = `/course/${course_id}/office-hours/${queue_id}`;

  // Get user's active requests in this specific queue
  const activeUserRequests = userRequests.filter(
    (request) => request.help_queue === Number(queue_id) && (request.status === "open" || request.status === "in_progress")
  );

  // Create navigation items for user's requests with queue positions
  const userRequestItems = activeUserRequests.map((request) => {
    const position = queueRequests.findIndex((queueRequest) => queueRequest.id === request.id) + 1;
    return {
      href: `${basePath}/${request.id}`,
      label: `My Request (Now #${position})`,
      isActive: pathname === `${basePath}/${request.id}`
    };
  });

  const navigationItems = [
    {
      href: basePath,
      label: `Queue Status (${queueRequests.length})`,
      isActive: pathname === basePath
    },
    ...userRequestItems,
    {
      href: `${basePath}/new`,
      label: "Submit Request",
      isActive: pathname === `${basePath}/new`
    },
    {
      href: `${basePath}/closed`,
      label: `Resolved Public Requests (${similarQuestions.length})`,
      isActive: pathname === `${basePath}/closed`
    },
    {
      href: `${basePath}/history`,
      label: `My History (${resolvedRequests.length})`,
      isActive: pathname === `${basePath}/history`
    }
  ];

  return (
    <ModerationBanNotice classId={Number(course_id)}>
      <Box m={4}>
        <Heading mb={4}>Help Queue: {helpQueue.name}</Heading>
        <Box display="flex" gap={6}>
          {/* Navigation Sidebar */}
          <VStack align="stretch" width="300px" gap={2}>
            {navigationItems.map((item) => (
              <Link key={item.href} href={item.href}>
                <Box
                  p={3}
                  borderRadius="md"
                  bg={item.isActive ? "bg.info" : "bg.muted"}
                  color={item.isActive ? "fg.info" : "fg.muted"}
                  _hover={{ bg: item.isActive ? "blue.emphasized" : "bg.emphasized" }}
                  cursor="pointer"
                  fontWeight={item.isActive ? "semibold" : "normal"}
                >
                  {item.label}
                </Box>
              </Link>
            ))}
          </VStack>

          {/* Main Content */}
          <Box flex="1">{children}</Box>
        </Box>
      </Box>
    </ModerationBanNotice>
  );
}
