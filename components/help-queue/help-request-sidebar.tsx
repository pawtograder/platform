"use client";

import { RequestRow } from "@/components/help-queue/request-row";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useHelpQueues, useHelpRequests, useHelpRequestStudents } from "@/hooks/useOfficeHoursRealtime";
import { useHelpRequestUnreadCount } from "@/hooks/useHelpRequestUnreadCount";
import { Box, HStack, Text, Badge, Separator } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { FaChevronLeft, FaChevronRight } from "react-icons/fa";

interface HelpRequestSidebarProps {
  requestId: number;
  isOpen: boolean;
  onToggle: () => void;
  queueId?: number;
  isManageMode?: boolean;
}

/**
 * Component to display unread message badge for a help request
 */
function UnreadBadge({ requestId, isAssignedToMe }: { requestId: number; isAssignedToMe: boolean }) {
  const unreadCount = useHelpRequestUnreadCount(requestId);

  if (unreadCount === 0 || !isAssignedToMe) return null;

  return (
    <Badge colorPalette="blue" variant="solid" size="sm" position="absolute" top="2" right="2" zIndex={1}>
      {unreadCount}
    </Badge>
  );
}

export function HelpRequestSidebar({
  requestId,
  isOpen,
  onToggle,
  queueId,
  isManageMode = false
}: HelpRequestSidebarProps) {
  const { course_id } = useParams();
  const { private_profile_id } = useClassProfiles();
  const allHelpRequests = useHelpRequests();
  const helpQueues = useHelpQueues();
  const helpRequestStudents = useHelpRequestStudents();

  // Get current request and queue
  const currentRequest = useMemo(() => {
    return allHelpRequests.find((r) => r.id === requestId);
  }, [allHelpRequests, requestId]);

  const currentQueue = useMemo(() => {
    if (queueId) {
      return helpQueues.find((q) => q.id === queueId);
    }
    if (currentRequest) {
      return helpQueues.find((q) => q.id === currentRequest.help_queue);
    }
    return null;
  }, [queueId, currentRequest, helpQueues]);

  // Get requests to show in sidebar
  const requestsForSidebar = useMemo(() => {
    if (isManageMode) {
      // In manage mode, show requests from queues the TA is working
      // For now, show all requests - can be filtered by active assignments later
      return allHelpRequests.filter(
        (r) => r.status === "open" || r.status === "in_progress" || r.assignee === private_profile_id
      );
    } else {
      // In student mode, show requests from current queue
      if (!currentQueue) return [];
      return allHelpRequests.filter((r) => r.help_queue === currentQueue.id);
    }
  }, [allHelpRequests, currentQueue, isManageMode, private_profile_id]);

  // Group and sort requests: currently working, then open, then closed
  const { workingRequests, openRequests, closedRequests } = useMemo(() => {
    const working: typeof requestsForSidebar = [];
    const open: typeof requestsForSidebar = [];
    const closed: typeof requestsForSidebar = [];

    requestsForSidebar.forEach((request) => {
      const isAssignedToMe = isManageMode && private_profile_id && request.assignee === private_profile_id;
      const isClosed = request.status === "closed" || request.status === "resolved";

      if (isAssignedToMe && (request.status === "open" || request.status === "in_progress")) {
        working.push(request);
      } else if (!isClosed && request.status === "open") {
        open.push(request);
      } else if (isClosed) {
        closed.push(request);
      }
    });

    // Sort working by oldest first
    working.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    // Sort open by oldest first
    open.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    // Sort closed by newest first
    closed.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return { workingRequests: working, openRequests: open, closedRequests: closed };
  }, [requestsForSidebar, isManageMode, private_profile_id]);

  // Create mapping of request ID to student profile IDs
  const requestStudentsMap = useMemo(() => {
    return helpRequestStudents.reduce(
      (acc, student) => {
        if (!acc[student.help_request_id]) {
          acc[student.help_request_id] = [];
        }
        acc[student.help_request_id].push(student.profile_id);
        return acc;
      },
      {} as Record<number, string[]>
    );
  }, [helpRequestStudents]);

  // Preserve scroll when switching requests
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastQueueIdRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number>(0);

  useEffect(() => {
    const currentQueueId = currentQueue?.id ?? null;
    const lastQueueId = lastQueueIdRef.current;

    // Update scroll for next time
    lastQueueIdRef.current = currentQueueId;

    // Restore only when queue is unchanged
    if (currentQueueId != null && lastQueueId != null && currentQueueId === lastQueueId) {
      const el = scrollRef.current;
      if (!el) return;
      // Wait for list to render
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = lastScrollTopRef.current;
        }
      });
    } else {
      // New queue: reset remembered scroll
      lastScrollTopRef.current = 0;
      const el = scrollRef.current;
      if (el) el.scrollTop = 0;
    }
  }, [requestId, currentQueue?.id, workingRequests.length, openRequests.length, closedRequests.length]);

  if (!isOpen) {
    return (
      <Box
        borderWidth="1px"
        borderColor="border.emphasized"
        bg="bg.panel"
        rounded="md"
        overflow="hidden"
        position={{ base: "relative", lg: "sticky" }}
        top="0"
        alignSelf="flex-start"
        width={{ base: "52px", lg: "52px" }}
      >
        <Box px="2" py="2">
          <Tooltip content="Show queue requests">
            <Button aria-label="Show queue requests" variant="ghost" size="sm" onClick={onToggle} width="100%">
              <FaChevronRight />
            </Button>
          </Tooltip>
          <Text mt="2" fontSize="xs" color="fg.muted" textAlign="center">
            {workingRequests.length + openRequests.length + closedRequests.length}
          </Text>
        </Box>
      </Box>
    );
  }

  const sidebarTitle = isManageMode
    ? currentQueue
      ? `Requests in ${currentQueue.name}`
      : "All Requests"
    : currentQueue
      ? `More in ${currentQueue.name}`
      : "Queue Requests";

  return (
    <Box
      borderWidth="1px"
      borderColor="border.emphasized"
      bg="bg.panel"
      rounded="md"
      overflow="hidden"
      position={{ base: "relative", lg: "sticky" }}
      top="0"
      alignSelf="flex-start"
      maxH={{ base: "calc(100dvh - 120px)", lg: "calc(100dvh - 120px)" }}
    >
      <Box px="4" py="3" borderBottomWidth="1px" borderColor="border.muted">
        <HStack justify="space-between" align="start" gap="2">
          <Box>
            <Text fontWeight="semibold" fontSize="sm">
              {sidebarTitle}
            </Text>
            <Text color="fg.muted" fontSize="xs">
              {workingRequests.length + openRequests.length + closedRequests.length} request
              {workingRequests.length + openRequests.length + closedRequests.length === 1 ? "" : "s"}
            </Text>
          </Box>
          <Tooltip content="Hide sidebar">
            <Button aria-label="Hide sidebar" variant="ghost" size="sm" onClick={onToggle}>
              <FaChevronLeft />
            </Button>
          </Tooltip>
        </HStack>
      </Box>

      <Box
        ref={scrollRef}
        overflowY="auto"
        maxH={{ base: "calc(100dvh - 180px)", lg: "calc(100dvh - 180px)" }}
        onScroll={(e) => {
          lastScrollTopRef.current = (e.target as HTMLDivElement).scrollTop;
        }}
      >
        {/* Currently Working */}
        {workingRequests.map((request) => {
          const queue = helpQueues.find((q) => q.id === request.help_queue);
          const students = requestStudentsMap[request.id] || [];
          const isAssignedToMe = isManageMode && private_profile_id && request.assignee === private_profile_id;

          return (
            <Box
              key={request.id}
              borderLeftWidth={isAssignedToMe ? "3px" : "0px"}
              borderLeftColor={isAssignedToMe ? "green.500" : "transparent"}
              position="relative"
            >
              <RequestRow
                request={request}
                href={
                  isManageMode
                    ? `/course/${course_id}/manage/office-hours/request/${request.id}`
                    : `/course/${course_id}/office-hours/${request.help_queue}/${request.id}`
                }
                selected={request.id === requestId}
                queue={queue}
                students={students}
                variant="compact"
              />
              {isAssignedToMe && <UnreadBadge requestId={request.id} isAssignedToMe={isAssignedToMe} />}
            </Box>
          );
        })}

        {/* Separator between working and open */}
        {workingRequests.length > 0 && openRequests.length > 0 && (
          <Box px="4" py="2">
            <Separator />
          </Box>
        )}

        {/* Open Requests */}
        {openRequests.map((request) => {
          const queue = helpQueues.find((q) => q.id === request.help_queue);
          const students = requestStudentsMap[request.id] || [];
          const isAssignedToMe = isManageMode && private_profile_id && request.assignee === private_profile_id;

          return (
            <Box
              key={request.id}
              borderLeftWidth={isAssignedToMe ? "3px" : "0px"}
              borderLeftColor={isAssignedToMe ? "green.500" : "transparent"}
              position="relative"
            >
              <RequestRow
                request={request}
                href={
                  isManageMode
                    ? `/course/${course_id}/manage/office-hours/request/${request.id}`
                    : `/course/${course_id}/office-hours/${request.help_queue}/${request.id}`
                }
                selected={request.id === requestId}
                queue={queue}
                students={students}
                variant="compact"
              />
              {isAssignedToMe && <UnreadBadge requestId={request.id} isAssignedToMe={isAssignedToMe} />}
            </Box>
          );
        })}

        {/* Separator between open and closed */}
        {(workingRequests.length > 0 || openRequests.length > 0) && closedRequests.length > 0 && (
          <Box px="4" py="2">
            <Separator />
          </Box>
        )}

        {/* Closed Requests */}
        {closedRequests.map((request) => {
          const queue = helpQueues.find((q) => q.id === request.help_queue);
          const students = requestStudentsMap[request.id] || [];
          const isAssignedToMe = isManageMode && private_profile_id && request.assignee === private_profile_id;

          return (
            <Box
              key={request.id}
              borderLeftWidth={isAssignedToMe ? "3px" : "0px"}
              borderLeftColor={isAssignedToMe ? "green.500" : "transparent"}
              position="relative"
            >
              <RequestRow
                request={request}
                href={
                  isManageMode
                    ? `/course/${course_id}/manage/office-hours/request/${request.id}`
                    : `/course/${course_id}/office-hours/${request.help_queue}/${request.id}`
                }
                selected={request.id === requestId}
                queue={queue}
                students={students}
                variant="compact"
              />
              {isAssignedToMe && <UnreadBadge requestId={request.id} isAssignedToMe={isAssignedToMe} />}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
