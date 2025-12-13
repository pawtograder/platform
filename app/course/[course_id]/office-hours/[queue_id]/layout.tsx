"use client";

import { Box, Heading, VStack } from "@chakra-ui/react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import ModerationBanNotice from "@/components/ui/moderation-ban-notice";
import { useQueueData } from "@/hooks/useQueueData";
import { useHelpQueue, useHelpQueueAssignments } from "@/hooks/useOfficeHoursRealtime";
import { useCourseController } from "@/hooks/useCourseController";
import { useEffect, useMemo } from "react";

interface LayoutProps {
  children: React.ReactNode;
}

interface NavigationItem {
  href: string;
  label: string;
  isActive: boolean;
  disabled?: boolean;
}

export default function QueueLayout({ children }: LayoutProps) {
  const { queue_id, course_id } = useParams();
  const pathname = usePathname();
  const helpQueue = useHelpQueue(Number(queue_id));
  const course = useCourseController();
  const allHelpQueueAssignments = useHelpQueueAssignments();

  const { queueRequests, userRequests, similarQuestions, resolvedRequests, isLoading, connectionStatus } = useQueueData(
    {
      courseId: Number(course_id),
      queueId: Number(queue_id)
    }
  );

  // Check if queue has an active assignment (must be before early returns)
  const hasActiveAssignment = useMemo(() => {
    if (!allHelpQueueAssignments) return false;
    return allHelpQueueAssignments.some(
      (assignment) => assignment.help_queue_id === Number(queue_id) && assignment.is_active
    );
  }, [allHelpQueueAssignments, queue_id]);

  const title = (() => {
    try {
      const c = course.course; // may throw until loaded
      return `${c.course_title || c.name} - Office Hours - Pawtograder`;
    } catch {
      return undefined;
    }
  })();

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

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
    (request) =>
      request.help_queue === Number(queue_id) && (request.status === "open" || request.status === "in_progress")
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

  const navigationItems: NavigationItem[] = [
    {
      href: basePath,
      label: `Queue Status (${queueRequests.length})`,
      isActive: pathname === basePath
    },
    ...userRequestItems,
    {
      href: `${basePath}/new`,
      label: "New Request",
      isActive: pathname === `${basePath}/new`,
      disabled: !hasActiveAssignment
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
      <Box m={{ base: 2, md: 4 }} maxW={{ base: "md", md: "6xl" }} mx="auto">
        <Heading mb={{ base: 2, md: 4 }} size={{ base: "md", md: "lg" }}>
          Help Queue: {helpQueue.name}
        </Heading>
        <Box display="flex" gap={{ base: 4, md: 6 }} flexDirection={{ base: "column", md: "row" }}>
          {/* Navigation Sidebar */}
          <VStack align="stretch" width={{ base: "100%", md: "300px" }} gap={2}>
            {navigationItems.map((item) => {
              const isNewRequest = item.label === "New Request";
              const isDisabled = item.disabled ?? false;

              const content = (
                <Box
                  p={{ base: 3, md: 3 }}
                  borderRadius="md"
                  bg={
                    isDisabled
                      ? "bg.muted"
                      : isNewRequest
                        ? item.isActive
                          ? "green.emphasized"
                          : "green.muted"
                        : item.isActive
                          ? "bg.info"
                          : "bg.muted"
                  }
                  color={
                    isDisabled
                      ? "fg.disabled"
                      : isNewRequest
                        ? item.isActive
                          ? "white"
                          : "green.fg"
                        : item.isActive
                          ? "fg.info"
                          : "fg.muted"
                  }
                  _hover={
                    isDisabled
                      ? {}
                      : {
                          bg: isNewRequest ? "green.emphasized" : item.isActive ? "blue.emphasized" : "bg.emphasized"
                        }
                  }
                  cursor={isDisabled ? "not-allowed" : "pointer"}
                  fontWeight={item.isActive ? "semibold" : "normal"}
                  opacity={isDisabled ? 0.6 : 1}
                >
                  {item.label}
                </Box>
              );

              if (isDisabled) {
                return <Box key={item.href}>{content}</Box>;
              }

              return (
                <Link key={item.href} href={item.href}>
                  {content}
                </Link>
              );
            })}
          </VStack>

          {/* Main Content */}
          <Box flex="1" maxW={{ base: "md", md: "full" }} mx={{ base: "auto", md: "0" }}>
            {children}
          </Box>
        </Box>
      </Box>
    </ModerationBanNotice>
  );
}
