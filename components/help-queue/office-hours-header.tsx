"use client";

import { Button } from "@/components/ui/button";
import { HelpRequestSearch } from "@/components/help-queue/help-request-search";
import { EscalationTour } from "@/components/help-queue/escalation-tour";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "@/components/ui/menu";
import { Box, Flex, HStack, Text, Badge } from "@chakra-ui/react";
import NextLink from "next/link";
import { FaPlus } from "react-icons/fa";
import { FiChevronRight, FiChevronDown } from "react-icons/fi";
import { useEffect, useMemo, useState } from "react";
import { useActiveHelpQueueAssignments, useHelpQueues } from "@/hooks/useOfficeHoursRealtime";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useParams, useRouter, usePathname } from "next/navigation";
import { useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import { toaster } from "@/components/ui/toaster";
import { useCapability, useIsInstructor, useIsStudent } from "@/hooks/useClassProfiles";
import { useOfficeHoursSchedule } from "@/hooks/useCalendarEvents";
import {
  completeOnboarding,
  useOnboardingCompleted,
  useOnboardingDataLoaded,
  useOnboardingHint,
  useOnboardingHintDismissed
} from "@/hooks/useOfficeHoursOnboarding";
import {
  countTextQueues,
  newRequestHint,
  nextOfficeHoursStart,
  queueDescriptionHintPending
} from "@/lib/officeHoursOnboarding";
import { OnboardingPopover } from "@/components/help-queue/onboarding-popover";
import { useFeatureEnabled } from "@/hooks/useCourseFeatures";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { useCourseController } from "@/hooks/useCourseController";
import { useIsTableControllerReady } from "@/lib/TableController";
import { format } from "date-fns";

export type OfficeHoursViewMode = "my-requests" | "browse" | "working" | "all-requests" | "dashboard" | "settings";

/**
 * The New Request hint's text while nobody is on duty. It names the next office hours on the
 * calendar, or says to check back later if the calendar has none coming up.
 *
 * This is its own component so that the calendar is read only while the hint is open. The popover
 * mounts its content when it opens, so pages where the hint never opens don't load the calendar.
 */
function NoStaffOnDutyMessage() {
  const { calendarEvents } = useCourseController();
  const calendarLoaded = useIsTableControllerReady(calendarEvents);
  const officeHoursEvents = useOfficeHoursSchedule();
  // Check the time again every minute, so office hours that have started stop being called "next".
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Until the calendar loads, "Check back later" might be wrong, so say only what is known.
  if (!calendarLoaded) return <>No one is on duty right now.</>;
  const next = nextOfficeHoursStart(officeHoursEvents, now);
  return (
    <>
      {next
        ? `No one is on duty right now. The next office hours start ${format(next, "EEE, MMM d 'at' h:mm a")}.`
        : "No one is on duty right now. Check back later."}
    </>
  );
}

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
  // Stop Working updates help_queue_assignments (help_students).
  const canHelpStudents = useCapability("help_students");
  // Use the specialized hook that subscribes to individual item changes
  // This ensures the header updates when staff starts/stops working
  const activeQueueAssignments = useActiveHelpQueueAssignments();
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
  // Uses activeQueueAssignments which properly subscribes to is_active changes
  const queuesWithActiveStaff = useMemo(() => {
    if (isManageMode) return [];
    const queueIdsWithActiveStaff = new Set(activeQueueAssignments.map((a) => a.help_queue_id));
    return helpQueues
      .filter((queue) => queue.available && queueIdsWithActiveStaff.has(queue.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [activeQueueAssignments, helpQueues, isManageMode]);

  // Onboarding hint on the New Request button (see lib/officeHoursOnboarding.ts). When nobody is on
  // duty, NoStaffOnDutyMessage gives the text.
  //
  // Only a student on the student pages of a course with the feature on takes part. For everyone
  // else, clicking New Request doesn't mark the onboarding complete, and nothing reads or writes
  // user_whats_new_seen.
  const onboardingOn = useFeatureEnabled(COURSE_FEATURES.OFFICE_HOURS_STUDENT_ONBOARDING);
  const isStudent = useIsStudent();
  const onboardingActive = onboardingOn && isStudent && !isManageMode;
  const onboardingCompleted = useOnboardingCompleted(onboardingActive, private_profile_id);
  const onboardingDataLoaded = useOnboardingDataLoaded();
  // On the queue list, the queue description hint on the page comes first. The header holds its
  // hint back until the student closes that one, so the order doesn't depend on which code loads
  // first (see queueDescriptionHintPending).
  //
  // It holds the hint while the page is still loading too. On a normal first visit the tables
  // arrive before every realtime channel has joined, and the page shows its loading message until
  // they do. If the header stopped waiting then, the New Request hint would open and then give way
  // to the queue hint a moment later. The cost: while realtime can't connect at all, the page
  // never gets past that message on this branch, and neither hint opens on a course with two or
  // more text queues. Once the page shows the list without realtime (#1341), the queue hint opens
  // and the New Request hint follows it.
  const onQueueList = mode === "browse" && (pathname === officeHoursBaseHref || pathname === `${officeHoursBaseHref}/`);
  const queueDescriptionDismissed = useOnboardingHintDismissed("read-queue-description");
  const newRequestHintId = newRequestHint({
    featureEnabled: onboardingOn,
    isStudent: isStudent && !isManageMode,
    completed: onboardingCompleted,
    staffOnDuty: queuesWithActiveStaff.length > 0,
    waitForQueueDescription: queueDescriptionHintPending({
      onQueueList,
      featureEnabled: onboardingOn,
      isStudent: isStudent && !isManageMode,
      completed: onboardingCompleted,
      textQueueCount: countTextQueues(helpQueues),
      dismissed: queueDescriptionDismissed
    })
  });
  const completeOnboardingOnClick = onboardingActive ? completeOnboarding : undefined;
  const newRequestOnboarding = useOnboardingHint(onboardingDataLoaded ? newRequestHintId : null);
  const newRequestHintMessage =
    newRequestHintId === "staff-on-duty" ? (
      "Staff are on duty. Click New Request to ask for help."
    ) : (
      <NoStaffOnDutyMessage />
    );

  // Get queues the TA is currently working
  const workingQueues = useMemo(() => {
    if (!isManageMode || !private_profile_id) return [];
    return activeQueueAssignments
      .filter((assignment) => assignment.ta_profile_id === private_profile_id)
      .map((assignment) => {
        const queue = helpQueues.find((q) => q.id === assignment.help_queue_id);
        return queue;
      })
      .filter(Boolean);
  }, [activeQueueAssignments, helpQueues, private_profile_id, isManageMode]);

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
                  <Text
                    fontSize="xs"
                    fontWeight="semibold"
                    color="fg"
                    truncate
                    maxW={{ base: "40vw", md: "25vw" }}
                    data-visual-test="transparent"
                    data-visual-placeholder="request-id"
                  >
                    Request #{currentRequest.id}
                  </Text>
                </Box>
              </HStack>
            )}
          </HStack>

          <HStack gap={2} flex="1" justify="flex-end" minW={{ base: "100%", md: "auto" }}>
            <EscalationTour />
            <HelpRequestSearch isManageMode={true} />
            {canHelpStudents && workingQueues.length > 0 && (
              <Button
                colorPalette="red"
                size="xs"
                onClick={async () => {
                  // Stop all working queues
                  for (const queue of workingQueues) {
                    if (!queue) continue;
                    // activeQueueAssignments already filtered for is_active === true
                    const assignment = activeQueueAssignments.find(
                      (a) => a.ta_profile_id === private_profile_id && a.help_queue_id === queue.id
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
                <Text
                  fontSize="sm"
                  fontWeight="semibold"
                  color="fg"
                  truncate
                  maxW={{ base: "60vw", md: "40vw" }}
                  data-visual-test="transparent"
                  data-visual-placeholder="request-id"
                >
                  Request #{currentRequest.id}
                </Text>
              </Box>
            </HStack>
          )}
        </HStack>

        <HStack gap={3} flex="1" justify="flex-end" minW={{ base: "100%", md: "auto" }}>
          <HelpRequestSearch isManageMode={false} />
          <OnboardingPopover
            active={onboardingActive}
            open={newRequestOnboarding.open}
            onDismiss={newRequestOnboarding.dismiss}
            message={newRequestHintMessage}
            placement="bottom-end"
          >
            <Box display="inline-flex" flexShrink={0}>
              {queuesWithActiveStaff.length === 0 ? (
                <Button colorPalette="green" size="sm" flexShrink={0} disabled>
                  <FaPlus />
                  New Request
                </Button>
              ) : queuesWithActiveStaff.length === 1 ? (
                <Button asChild colorPalette="green" size="sm" flexShrink={0}>
                  <NextLink
                    href={`${officeHoursBaseHref}/${queuesWithActiveStaff[0].id}/new`}
                    onClick={completeOnboardingOnClick}
                  >
                    <FaPlus />
                    New Request
                  </NextLink>
                </Button>
              ) : (
                <MenuRoot>
                  <MenuTrigger asChild>
                    {/* Clicking the button counts, even if the student closes the menu without
                        picking a queue. */}
                    <Button colorPalette="green" size="sm" flexShrink={0} onClick={completeOnboardingOnClick}>
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
            </Box>
          </OnboardingPopover>
        </HStack>
      </Flex>
    </Box>
  );
}
