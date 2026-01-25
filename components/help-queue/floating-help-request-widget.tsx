"use client";

import { RealtimeChat } from "@/components/realtime-chat";
import { useActiveHelpRequest } from "@/hooks/useActiveHelpRequest";
import { useHelpRequestUnreadCount } from "@/hooks/useHelpRequestUnreadCount";
import { useMessageNotifications } from "@/hooks/useMessageNotifications";
import { useHelpRequestStudents, useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import { useClassProfiles, useFeatureEnabled } from "@/hooks/useClassProfiles";
import { useHelpDrawer } from "@/hooks/useHelpDrawer";
import { Badge, Box, Button, Card, Flex, HStack, Icon, IconButton, Stack, Text } from "@chakra-ui/react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { BsArrowRight, BsChatDots, BsCheckCircle, BsChevronDown, BsChevronUp, BsQuestionCircle } from "react-icons/bs";
import { useHelpQueues, useHelpQueueAssignments, useHelpRequests } from "@/hooks/useOfficeHoursRealtime";
import { Tooltip } from "@/components/ui/tooltip";
import { toaster } from "@/components/ui/toaster";
import type { HelpRequestResolutionStatus } from "@/utils/supabase/DatabaseTypes";
import useModalManager from "@/hooks/useModalManager";

const HelpDrawer = dynamic(() => import("@/components/help-queue/help-drawer"), {
  ssr: false
});

const HelpRequestResolutionModal = dynamic(() => import("@/components/help-queue/help-request-resolution-modal"), {
  ssr: false
});
export function FloatingHelpRequestWidget() {
  const activeRequest = useActiveHelpRequest();
  const router = useRouter();
  const pathname = usePathname();
  const { course_id } = useParams();
  const { role, private_profile_id } = useClassProfiles();
  const featureEnabled = useFeatureEnabled("office-hours");
  const { isOpen: isDrawerOpen, openDrawer, closeDrawer } = useHelpDrawer();
  const [isExpanded, setIsExpanded] = useState(false);
  const unreadCount = useHelpRequestUnreadCount(activeRequest?.request.id);
  const allHelpRequestStudents = useHelpRequestStudents();
  const allHelpQueues = useHelpQueues();
  const allHelpQueueAssignments = useHelpQueueAssignments();
  const allHelpRequests = useHelpRequests();
  const resolutionModal = useModalManager();
  const controller = useOfficeHoursController();
  const { helpRequests, studentHelpActivity } = controller;

  // Check if user is on an office hours page (don't show widget there)
  const isOnOfficeHoursPage = useMemo(() => {
    if (!pathname) return false;
    return pathname.includes("/office-hours");
  }, [pathname]);

  // Get queue with ordinal 0 (default queue)
  const defaultQueue = useMemo(() => {
    return allHelpQueues.find((queue) => queue.ordinal === 0);
  }, [allHelpQueues]);

  // Check if default queue is staffed
  const isDefaultQueueStaffed = useMemo(() => {
    if (!defaultQueue) return false;
    const activeAssignments = allHelpQueueAssignments.filter((assignment) => assignment.is_active);
    return activeAssignments.some((assignment) => assignment.help_queue_id === defaultQueue.id);
  }, [defaultQueue, allHelpQueueAssignments]);

  // Count open help requests
  const openRequestCount = useMemo(() => {
    return allHelpRequests.filter((request) => request.status === "open" || request.status === "in_progress").length;
  }, [allHelpRequests]);

  // Determine status subtitle for the Get Help button
  const statusSubtitle = useMemo(() => {
    if (isDefaultQueueStaffed && openRequestCount === 0) {
      return "Staff ready now!";
    } else if (openRequestCount > 0 && openRequestCount < 5) {
      return "Queue is short";
    }
    return null;
  }, [isDefaultQueueStaffed, openRequestCount]);

  const tooltipText = "Text chat or video chat with a TA right now!";

  // Compute student IDs for the active request
  const helpRequestStudentIds = useMemo(() => {
    if (!activeRequest) return [];
    return allHelpRequestStudents
      .filter((student) => student.help_request_id === activeRequest.request.id)
      .map((student) => student.profile_id);
  }, [activeRequest, allHelpRequestStudents]);

  // Enable notifications for active help request site-wide
  // This ensures students get notified even when:
  // 1. They're on a different page of the site
  // 2. The widget is minimized (chat not visible)
  // 3. The browser is backgrounded or another app is in front
  // 4. They're on the office hours pages but not viewing their specific request
  // Note: When widget is expanded OR student is on the help request page, RealtimeChat handles notifications
  const isOnHelpRequestPage = pathname?.match(/\/office-hours\/[^/]+\/\d+$/);
  useMessageNotifications({
    helpRequestId: activeRequest?.request.id ?? 0,
    enabled: !!activeRequest && !isExpanded && !isOnHelpRequestPage,
    titlePrefix: "Help Request"
  });

  const handleNavigateToRequest = useCallback(() => {
    if (activeRequest) {
      router.push(`/course/${course_id}/office-hours/${activeRequest.request.help_queue}/${activeRequest.request.id}`);
    }
  }, [activeRequest, course_id, router]);

  // Handle resolution from the modal
  const handleResolutionSuccess = useCallback(
    async (resolutionStatus: HelpRequestResolutionStatus, _feedback?: unknown, notes?: string) => {
      if (!activeRequest || !private_profile_id) return;

      try {
        // Update the help request with resolution status
        await helpRequests.update(activeRequest.request.id, {
          status: "resolved",
          resolved_by: private_profile_id,
          resolved_at: new Date().toISOString(),
          resolution_status: resolutionStatus,
          resolution_notes: notes || null
        });

        // Log activity for students
        const requestStudents = allHelpRequestStudents.filter(
          (student) => student.help_request_id === activeRequest.request.id
        );
        for (const student of requestStudents) {
          try {
            await studentHelpActivity.create({
              student_profile_id: student.profile_id,
              class_id: activeRequest.request.class_id,
              help_request_id: activeRequest.request.id,
              activity_type: "request_resolved",
              activity_description: `Request resolved by student (${resolutionStatus})`
            });
          } catch {
            // Don't block on activity logging failures
          }
        }

        toaster.success({
          title: "Help Request Resolved",
          description: "Your help request has been resolved."
        });
      } catch (error) {
        toaster.error({
          title: "Error",
          description: `Failed to resolve request: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    },
    [activeRequest, private_profile_id, helpRequests, studentHelpActivity, allHelpRequestStudents]
  );

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        if (e.key === " ") {
          e.preventDefault();
        }
        handleToggleExpand();
      }
    },
    [handleToggleExpand]
  );

  // Only show for students when feature is enabled
  if (role.role !== "student" || !featureEnabled) {
    return null;
  }

  // Don't show widget when student is already on the office hours pages
  if (isOnOfficeHoursPage) {
    return null;
  }

  // Show "Get Help" button when no active request
  if (!activeRequest) {
    return (
      <>
        <Box position="fixed" bottom={4} right={4} zIndex={1000}>
          <Tooltip content={tooltipText} positioning={{ placement: "left" }}>
            <Button
              size="md"
              colorPalette="green"
              onClick={openDrawer}
              boxShadow="lg"
              _hover={{ transform: "scale(1.02)", boxShadow: "xl" }}
              transition="all 0.2s"
              px={4}
              py={3}
              h="auto"
            >
              <Icon as={BsQuestionCircle} boxSize={5} mr={2} flexShrink={0} />
              <Stack gap={0} align="start">
                <Text fontWeight="semibold" fontSize="md">
                  Get Help
                </Text>
                {statusSubtitle && (
                  <Text fontSize="xs" fontWeight="normal" opacity={0.9}>
                    {statusSubtitle}
                  </Text>
                )}
              </Stack>
            </Button>
          </Tooltip>
        </Box>
        {isDrawerOpen && <HelpDrawer isOpen={isDrawerOpen} onClose={closeDrawer} />}
      </>
    );
  }

  const statusColor =
    activeRequest.request.status === "in_progress"
      ? "orange"
      : activeRequest.request.status === "open"
        ? "blue"
        : "gray";

  return (
    <Box
      position="fixed"
      bottom={4}
      right={4}
      zIndex={1000}
      maxW={{ base: "calc(100vw - 2rem)", md: "400px" }}
      w="100%"
    >
      <Card.Root>
        <Card.Body p={0}>
          {!isExpanded ? (
            // Minimized state
            <Flex
              align="center"
              gap={3}
              p={4}
              cursor="pointer"
              role="button"
              tabIndex={0}
              onClick={handleToggleExpand}
              onKeyDown={handleKeyDown}
              _hover={{ bg: "bg.subtle" }}
              borderLeftWidth={unreadCount > 0 ? "4px" : "0"}
              borderLeftColor={unreadCount > 0 ? "red.500" : "transparent"}
              bg={unreadCount > 0 ? "red.50" : undefined}
              _dark={{ bg: unreadCount > 0 ? "red.900" : undefined }}
            >
              <Box
                p={2}
                borderRadius="md"
                bg={unreadCount > 0 ? "red.100" : `${statusColor}.50`}
                _dark={{ bg: unreadCount > 0 ? "red.800" : `${statusColor}.900` }}
                position="relative"
              >
                <Icon as={BsChatDots} boxSize={5} color={unreadCount > 0 ? "red.600" : `${statusColor}.600`} />
                {unreadCount > 0 && (
                  <Badge
                    colorPalette="red"
                    variant="solid"
                    position="absolute"
                    top="-1"
                    right="-1"
                    borderRadius="full"
                    minW="5"
                    h="5"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    fontSize="xs"
                    fontWeight="bold"
                    boxShadow="0 0 0 2px white"
                    _dark={{ boxShadow: "0 0 0 2px var(--chakra-colors-gray-800)" }}
                    css={{
                      "@keyframes pulse": {
                        "0%, 100%": { opacity: 1 },
                        "50%": { opacity: 0.5 }
                      },
                      animation: unreadCount > 0 ? "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite" : undefined
                    }}
                  >
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </Badge>
                )}
              </Box>
              <Stack flex="1" minW={0} spaceY={0.5}>
                <Text
                  fontWeight="semibold"
                  fontSize="sm"
                  truncate
                  color={unreadCount > 0 ? "red.700" : undefined}
                  _dark={{ color: unreadCount > 0 ? "red.300" : undefined }}
                >
                  Help Request
                  {unreadCount > 0 && " • New Messages!"}
                </Text>
                <Badge colorPalette={statusColor} variant="solid" size="sm">
                  {activeRequest.request.status === "in_progress"
                    ? "Staff is here helping you now!"
                    : activeRequest.request.status}
                </Badge>
                <Text
                  fontSize="xs"
                  color={unreadCount > 0 ? "red.600" : "fg.muted"}
                  truncate
                  fontWeight={unreadCount > 0 ? "semibold" : "normal"}
                  _dark={{ color: unreadCount > 0 ? "red.400" : undefined }}
                >
                  {unreadCount > 0 ? (
                    <>
                      {unreadCount} unread message{unreadCount !== 1 ? "s" : ""} • Position #
                      {activeRequest.queuePosition}
                    </>
                  ) : (
                    `Position #${activeRequest.queuePosition} in ${activeRequest.queueName}`
                  )}
                </Text>
              </Stack>
              <HStack gap={1}>
                <Tooltip content="Resolve request" positioning={{ placement: "top" }}>
                  <IconButton
                    aria-label="Resolve request"
                    variant="ghost"
                    size="sm"
                    colorPalette="green"
                    onClick={(e) => {
                      e.stopPropagation();
                      resolutionModal.openModal();
                    }}
                  >
                    <Icon as={BsCheckCircle} />
                  </IconButton>
                </Tooltip>
                <IconButton
                  aria-label="Go to request"
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNavigateToRequest();
                  }}
                >
                  <Icon as={BsArrowRight} />
                </IconButton>
                <IconButton
                  aria-label="Expand chat"
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleExpand();
                  }}
                >
                  <Icon as={BsChevronUp} />
                </IconButton>
              </HStack>
            </Flex>
          ) : (
            // Expanded state
            <Stack>
              <Flex
                align="center"
                justify="space-between"
                p={3}
                borderBottomWidth="1px"
                borderColor="border.muted"
                bg="bg.subtle"
              >
                <HStack gap={2} flex="1" minW={0}>
                  <Badge colorPalette={statusColor} variant="solid" size="sm">
                    #{activeRequest.queuePosition}
                  </Badge>
                  <Text fontWeight="semibold" fontSize="sm" truncate>
                    {activeRequest.queueName}
                  </Text>
                  <Badge colorPalette={statusColor} variant="subtle" size="sm">
                    {activeRequest.request.status}
                  </Badge>
                </HStack>
                <HStack gap={1}>
                  <Tooltip content="Resolve request" positioning={{ placement: "top" }}>
                    <IconButton
                      aria-label="Resolve request"
                      variant="ghost"
                      size="sm"
                      colorPalette="green"
                      onClick={() => resolutionModal.openModal()}
                    >
                      <Icon as={BsCheckCircle} />
                    </IconButton>
                  </Tooltip>
                  <IconButton
                    aria-label="Go to full request page"
                    variant="ghost"
                    size="sm"
                    onClick={handleNavigateToRequest}
                  >
                    <Icon as={BsArrowRight} />
                  </IconButton>
                  <IconButton aria-label="Minimize" variant="ghost" size="sm" onClick={handleToggleExpand}>
                    <Icon as={BsChevronDown} />
                  </IconButton>
                </HStack>
              </Flex>
              <Box h={{ base: "60vh", md: "400px" }} maxH="400px" overflow="hidden">
                <RealtimeChat
                  request_id={activeRequest.request.id}
                  helpRequestStudentIds={helpRequestStudentIds}
                  readOnly={false}
                />
              </Box>
            </Stack>
          )}
        </Card.Body>
      </Card.Root>

      {/* Resolution Modal */}
      {resolutionModal.isOpen && activeRequest && private_profile_id && (
        <HelpRequestResolutionModal
          isOpen={resolutionModal.isOpen}
          onClose={resolutionModal.closeModal}
          onSuccess={handleResolutionSuccess}
          helpRequestId={activeRequest.request.id}
          classId={activeRequest.request.class_id}
          studentProfileId={private_profile_id}
          showFeedback={true}
          title="Resolve Help Request"
        />
      )}
    </Box>
  );
}
