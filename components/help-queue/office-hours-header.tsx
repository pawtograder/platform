"use client";

import { Button } from "@/components/ui/button";
import { HelpRequestSearch } from "@/components/help-queue/help-request-search";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "@/components/ui/menu";
import { Box, Flex, HStack, Text, Badge } from "@chakra-ui/react";
import NextLink from "next/link";
import { FaPlus } from "react-icons/fa";
import { FiChevronRight, FiChevronDown } from "react-icons/fi";
import { useMemo } from "react";
import { useHelpQueueAssignments, useHelpQueues } from "@/hooks/useOfficeHoursRealtime";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useParams, useRouter, usePathname } from "next/navigation";
import { useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import { toaster } from "@/components/ui/toaster";
import { useIsInstructor } from "@/hooks/useClassProfiles";

export type OfficeHoursViewMode = "my-requests" | "browse" | "working" | "all-requests" | "dashboard" | "settings";

function NavLink({ href, selected, children }: { href: string; selected: boolean; children: React.ReactNode }) {
  return (
    <NextLink href={href}>
      <Box
        px={2}
        py={1}
        rounded="md"
        fontSize="xs"
        fontWeight={selected ? "semibold" : "medium"}
        bg={selected ? "bg.emphasized" : "transparent"}
        color={selected ? "fg" : "fg.muted"}
        borderWidth="1px"
        borderColor={selected ? "border.emphasized" : "transparent"}
        cursor="pointer"
        transition="all 0.2s"
        _hover={{
          bg: selected ? "bg.emphasized" : "bg.subtle",
          color: "fg",
          borderColor: selected ? "border.emphasized" : "border.muted"
        }}
      >
        {children}
      </Box>
    </NextLink>
  );
}

interface OfficeHoursHeaderProps {
  mode: OfficeHoursViewMode;
  officeHoursBaseHref: string;
  currentRequest?: { id: number; queueName: string; queueId?: number };
  isManageMode?: boolean;
}

export function OfficeHoursHeader({
  mode,
  officeHoursBaseHref,
  currentRequest,
  isManageMode = false
}: OfficeHoursHeaderProps) {
  const { course_id, queue_id } = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const { private_profile_id } = useClassProfiles();
  const isInstructor = useIsInstructor();
  const allQueueAssignments = useHelpQueueAssignments();
  const helpQueues = useHelpQueues();
  const controller = useOfficeHoursController();
  const { helpQueueAssignments } = controller;

  const showRequestCrumb = !!currentRequest;

  // Get queue ID from current request, falling back to queue_id from params
  const currentRequestQueueId = useMemo(() => {
    if (currentRequest?.queueId) {
      return currentRequest.queueId;
    }
    return queue_id ? Number(queue_id) : undefined;
  }, [currentRequest?.queueId, queue_id]);

  // Get queues with active staff assignments (for student mode)
  const queuesWithActiveStaff = useMemo(() => {
    if (isManageMode) return [];
    const activeAssignments = allQueueAssignments.filter((assignment) => assignment.is_active);
    const queueIdsWithActiveStaff = new Set(activeAssignments.map((a) => a.help_queue_id));
    return helpQueues
      .filter((queue) => queue.available && queueIdsWithActiveStaff.has(queue.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allQueueAssignments, helpQueues, isManageMode]);

  // Get queues the TA is currently working
  const workingQueues = useMemo(() => {
    if (!isManageMode || !private_profile_id) return [];
    return allQueueAssignments
      .filter((assignment) => assignment.ta_profile_id === private_profile_id && assignment.is_active)
      .map((assignment) => {
        const queue = helpQueues.find((q) => q.id === assignment.help_queue_id);
        return queue;
      })
      .filter(Boolean);
  }, [allQueueAssignments, helpQueues, private_profile_id, isManageMode]);

  const handleStartStopWorking = async (queueId: number, isWorking: boolean, assignmentId?: number) => {
    // Guard: check if private_profile_id is present before proceeding
    if (!private_profile_id) {
      toaster.error({
        title: "Error",
        description: "Unable to start working: user profile not found. Please refresh the page."
      });
      return;
    }

    try {
      if (isWorking && assignmentId) {
        await helpQueueAssignments.update(assignmentId, {
          is_active: false,
          ended_at: new Date().toISOString()
        });
        toaster.success({
          title: "Success",
          description: "Stopped working on queue"
        });
      } else {
        await helpQueueAssignments.create({
          class_id: Number(course_id),
          help_queue_id: queueId,
          ta_profile_id: private_profile_id,
          is_active: true,
          started_at: new Date().toISOString(),
          ended_at: null,
          max_concurrent_students: 1
        });
        toaster.success({
          title: "Success",
          description: "Started working on queue"
        });
      }
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to ${isWorking ? "stop" : "start"} working on queue: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  if (isManageMode) {
    const isWorkingPage = pathname === officeHoursBaseHref || pathname === `${officeHoursBaseHref}/`;
    const isAllRequestsPage = pathname?.startsWith(`${officeHoursBaseHref}/all-requests`);
    const isSettingsPage = pathname?.startsWith(`${officeHoursBaseHref}/settings`);

    // Manage mode header - compact design
    return (
      <Box
        position="sticky"
        top="0"
        zIndex={10}
        bg="bg.panel"
        borderBottomWidth="1px"
        borderColor="border.emphasized"
        px={{ base: 2, md: 3 }}
        py={{ base: 2, md: 2 }}
      >
        <Flex align="center" justify="space-between" gap={2} wrap="wrap">
          <HStack gap={2} flexShrink={0} align="center">
            <HStack gap={2}>
              <HStack gap={1} align="center">
                <NavLink href={officeHoursBaseHref} selected={!showRequestCrumb && isWorkingPage}>
                  Working
                </NavLink>
                {workingQueues.length > 0 && (
                  <Badge
                    colorPalette="green"
                    variant="subtle"
                    size="xs"
                    whiteSpace="nowrap"
                    title={workingQueues
                      .map((q) => q?.name)
                      .filter(Boolean)
                      .join(", ")}
                  >
                    {workingQueues.length === 1 ? workingQueues[0]?.name : `${workingQueues.length} queues`}
                  </Badge>
                )}
              </HStack>
              <NavLink href={`${officeHoursBaseHref}/all-requests`} selected={!showRequestCrumb && isAllRequestsPage}>
                All Requests
              </NavLink>
              <MenuRoot>
                <MenuTrigger asChild>
                  <Box
                    px={2}
                    py={1}
                    rounded="md"
                    fontSize="xs"
                    fontWeight={isSettingsPage ? "semibold" : "medium"}
                    bg={isSettingsPage ? "bg.emphasized" : "transparent"}
                    color={isSettingsPage ? "fg" : "fg.muted"}
                    borderWidth="1px"
                    borderColor={isSettingsPage ? "border.emphasized" : "transparent"}
                    cursor="pointer"
                    transition="all 0.2s"
                    _hover={{
                      bg: isSettingsPage ? "bg.emphasized" : "bg.subtle",
                      color: "fg",
                      borderColor: isSettingsPage ? "border.emphasized" : "border.muted"
                    }}
                    display="flex"
                    alignItems="center"
                    gap={1}
                  >
                    Settings
                    <FiChevronDown />
                  </Box>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem
                    value="queues"
                    onClick={() => {
                      router.push(`${officeHoursBaseHref}/settings/queues`);
                    }}
                  >
                    Queue Management
                  </MenuItem>
                  <MenuItem
                    value="assignments"
                    onClick={() => {
                      router.push(`${officeHoursBaseHref}/settings/assignments`);
                    }}
                  >
                    Assignment Management
                  </MenuItem>
                  <MenuItem
                    value="templates"
                    onClick={() => {
                      router.push(`${officeHoursBaseHref}/settings/templates`);
                    }}
                  >
                    Templates
                  </MenuItem>
                  <MenuItem
                    value="moderation"
                    onClick={() => {
                      router.push(`${officeHoursBaseHref}/settings/moderation`);
                    }}
                  >
                    Moderation
                  </MenuItem>
                  <MenuItem
                    value="karma"
                    onClick={() => {
                      router.push(`${officeHoursBaseHref}/settings/karma`);
                    }}
                  >
                    Student Karma
                  </MenuItem>
                  <MenuItem
                    value="activity"
                    onClick={() => {
                      router.push(`${officeHoursBaseHref}/settings/activity`);
                    }}
                  >
                    Student Activity
                  </MenuItem>
                  <MenuItem
                    value="time-tracking"
                    onClick={() => {
                      router.push(`${officeHoursBaseHref}/settings/time-tracking`);
                    }}
                  >
                    Time Tracking
                  </MenuItem>
                  {isInstructor && (
                    <MenuItem
                      value="feedback"
                      onClick={() => {
                        router.push(`${officeHoursBaseHref}/settings/feedback`);
                      }}
                    >
                      Feedback
                    </MenuItem>
                  )}
                </MenuContent>
              </MenuRoot>
            </HStack>
            {currentRequest && (
              <HStack gap={1} color="fg.muted">
                <FiChevronRight size={12} />
                <NextLink
                  href={
                    currentRequestQueueId
                      ? `${officeHoursBaseHref}/all-requests?queue=${currentRequestQueueId}`
                      : `${officeHoursBaseHref}/all-requests`
                  }
                >
                  <Text fontSize="xs" fontWeight="medium" color="fg" _hover={{ textDecoration: "underline" }}>
                    {currentRequest.queueName}
                  </Text>
                </NextLink>
                <FiChevronRight size={12} />
                <Box borderBottom="2px solid" borderColor="orange.600" pb={0.5}>
                  <Text fontSize="xs" fontWeight="semibold" color="fg" truncate maxW={{ base: "40vw", md: "25vw" }}>
                    Request #{currentRequest.id}
                  </Text>
                </Box>
              </HStack>
            )}
          </HStack>

          <HStack gap={2} flex="1" justify="flex-end" minW={{ base: "100%", md: "auto" }}>
            <HelpRequestSearch isManageMode={true} />
            {workingQueues.length > 0 && (
              <Button
                colorPalette="red"
                size="xs"
                onClick={async () => {
                  // Stop all working queues
                  for (const queue of workingQueues) {
                    if (!queue) continue;
                    const assignment = allQueueAssignments.find(
                      (a) => a.ta_profile_id === private_profile_id && a.is_active && a.help_queue_id === queue.id
                    );
                    if (assignment) {
                      await handleStartStopWorking(queue.id, true, assignment.id);
                    }
                  }
                }}
              >
                Stop Working ({workingQueues.length})
              </Button>
            )}
          </HStack>
        </Flex>
      </Box>
    );
  }

  // Student mode header
  return (
    <Box
      position="sticky"
      top="0"
      zIndex={10}
      bg="bg.panel"
      borderBottomWidth="1px"
      borderColor="border.emphasized"
      px={{ base: 3, md: 6 }}
      py={{ base: 3, md: 4 }}
    >
      <Flex align="center" justify="space-between" gap={4} wrap="wrap">
        <HStack gap={4} flexShrink={0} align="center">
          <HStack gap={4}>
            <NavLink
              href={`${officeHoursBaseHref}?view=my-requests`}
              selected={!showRequestCrumb && mode === "my-requests"}
            >
              My Requests
            </NavLink>
            <NavLink href={`${officeHoursBaseHref}?view=browse`} selected={!showRequestCrumb && mode === "browse"}>
              Browse Queues
            </NavLink>
          </HStack>
          {currentRequest && (
            <HStack gap={2} color="fg.muted">
              <FiChevronRight />
              <NextLink
                href={
                  currentRequestQueueId
                    ? `${officeHoursBaseHref}?view=browse&queue=${currentRequestQueueId}`
                    : `${officeHoursBaseHref}?view=browse`
                }
              >
                <Text fontSize="sm" fontWeight="medium" color="fg" _hover={{ textDecoration: "underline" }}>
                  {currentRequest.queueName}
                </Text>
              </NextLink>
              <FiChevronRight />
              <Box borderBottom="3px solid" borderColor="orange.600" pb={1}>
                <Text fontSize="sm" fontWeight="semibold" color="fg" truncate maxW={{ base: "60vw", md: "40vw" }}>
                  Request #{currentRequest.id}
                </Text>
              </Box>
            </HStack>
          )}
        </HStack>

        <HStack gap={3} flex="1" justify="flex-end" minW={{ base: "100%", md: "auto" }}>
          <HelpRequestSearch isManageMode={false} />
          {queuesWithActiveStaff.length === 0 ? (
            <Button colorPalette="green" size="sm" flexShrink={0} disabled>
              <FaPlus />
              New Request
            </Button>
          ) : queuesWithActiveStaff.length === 1 ? (
            <Button asChild colorPalette="green" size="sm" flexShrink={0}>
              <NextLink href={`${officeHoursBaseHref}/${queuesWithActiveStaff[0].id}/new`}>
                <FaPlus />
                New Request
              </NextLink>
            </Button>
          ) : (
            <MenuRoot>
              <MenuTrigger asChild>
                <Button colorPalette="green" size="sm" flexShrink={0}>
                  <FaPlus />
                  New Request
                  <FiChevronDown />
                </Button>
              </MenuTrigger>
              <MenuContent>
                {queuesWithActiveStaff.map((queue) => (
                  <MenuItem
                    key={queue.id}
                    value={queue.id.toString()}
                    onClick={() => {
                      router.push(`${officeHoursBaseHref}/${queue.id}/new`);
                    }}
                  >
                    {queue.name}
                  </MenuItem>
                ))}
              </MenuContent>
            </MenuRoot>
          )}
        </HStack>
      </Flex>
    </Box>
  );
}
