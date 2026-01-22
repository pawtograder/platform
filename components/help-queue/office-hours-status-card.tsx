"use client";

import { useHelpQueueAssignments, useHelpQueues, useHelpRequests } from "@/hooks/useOfficeHoursRealtime";
import { useClassProfiles, useFeatureEnabled } from "@/hooks/useClassProfiles";
import { useHelpDrawer } from "@/hooks/useHelpDrawer";
import {
  Badge,
  Box,
  Button,
  CardBody,
  CardHeader,
  CardRoot,
  Heading,
  HStack,
  Icon,
  Stack,
  Text
} from "@chakra-ui/react";
import { Tooltip } from "@/components/ui/tooltip";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "@/components/ui/menu";
import { useParams, useRouter } from "next/navigation";
import { useMemo } from "react";
import { FaPlus, FaQuestionCircle } from "react-icons/fa";
import { FiChevronDown } from "react-icons/fi";
import PersonAvatar from "@/components/ui/person-avatar";
import dynamic from "next/dynamic";

const HelpDrawer = dynamic(() => import("@/components/help-queue/help-drawer"), {
  ssr: false
});

export function OfficeHoursStatusCard() {
  const { course_id } = useParams();
  const router = useRouter();
  const { role } = useClassProfiles();
  const featureEnabled = useFeatureEnabled("office-hours");
  const { isOpen: isDrawerOpen, openDrawer, closeDrawer } = useHelpDrawer();
  const allHelpQueues = useHelpQueues();
  const allHelpQueueAssignments = useHelpQueueAssignments();
  const allHelpRequests = useHelpRequests();

  // Filter to available queues
  const helpQueues = allHelpQueues.filter((queue) => queue.available);

  // Filter to active assignments
  const activeAssignments = allHelpQueueAssignments.filter((assignment) => assignment.is_active);

  // Get active help requests
  const activeHelpRequests = allHelpRequests.filter(
    (request) => request.status === "open" || request.status === "in_progress"
  );

  // Group active assignments by queue
  const activeAssignmentsByQueue = useMemo(() => {
    return activeAssignments.reduce(
      (acc, assignment) => {
        const queueId = assignment.help_queue_id;
        if (!acc[queueId]) {
          acc[queueId] = [];
        }
        acc[queueId].push(assignment);
        return acc;
      },
      {} as Record<number, typeof activeAssignments>
    );
  }, [activeAssignments]);

  // Get queues with active staff
  const queuesWithActiveStaff = useMemo(() => {
    const queueIdsWithActiveStaff = new Set(activeAssignments.map((a) => a.help_queue_id));
    return helpQueues
      .filter((queue) => queueIdsWithActiveStaff.has(queue.id))
      .sort((a, b) => {
        // Primary sort: by ordinal
        if (a.ordinal !== b.ordinal) {
          return a.ordinal - b.ordinal;
        }
        // Secondary sort: alphabetically by name
        return a.name.localeCompare(b.name);
      });
  }, [helpQueues, activeAssignments]);

  // Calculate request counts per queue
  const requestCountsByQueue = useMemo(() => {
    return activeHelpRequests.reduce(
      (acc, request) => {
        const queueId = request.help_queue;
        acc[queueId] = (acc[queueId] || 0) + 1;
        return acc;
      },
      {} as Record<number, number>
    );
  }, [activeHelpRequests]);

  // Get queue with ordinal 0 (default queue)
  const defaultQueue = useMemo(() => {
    return helpQueues.find((queue) => queue.ordinal === 0);
  }, [helpQueues]);

  // Check if default queue is staffed
  const isDefaultQueueStaffed = useMemo(() => {
    if (!defaultQueue) return false;
    return (activeAssignmentsByQueue[defaultQueue.id]?.length ?? 0) > 0;
  }, [defaultQueue, activeAssignmentsByQueue]);

  // Count open help requests
  const openRequestCount = activeHelpRequests.length;

  // Determine button text and tooltip
  const buttonText = useMemo(() => {
    if (isDefaultQueueStaffed && openRequestCount === 0) {
      return "Help queue is empty, staff are ready to help you right now";
    } else if (openRequestCount > 0 && openRequestCount < 5) {
      return "Queue is short, join it";
    }
    return "Get Help";
  }, [isDefaultQueueStaffed, openRequestCount]);

  const tooltipText = "Text chat or video chat with a TA right now!";

  // Only show for students when feature is enabled
  if (role.role !== "student" || !featureEnabled) {
    return null;
  }

  const handleViewQueue = (queueId: number) => {
    router.push(`/course/${course_id}/office-hours?view=browse&queue=${queueId}`);
  };

  const handleNewRequest = (queueId: number) => {
    router.push(`/course/${course_id}/office-hours/${queueId}/new`);
  };

  const handleViewAllRequests = () => {
    router.push(`/course/${course_id}/office-hours?view=browse`);
  };

  return (
    <Box>
      <HStack justify="space-between" align="center" mb={4} flexWrap="wrap" gap={2}>
        <Heading size="lg">Office Hours</Heading>
        <HStack gap={2} flexWrap="wrap">
          {queuesWithActiveStaff.length === 0 ? (
            <Tooltip content={tooltipText} positioning={{ placement: "bottom" }}>
              <Button
                size="md"
                colorPalette="green"
                onClick={openDrawer}
                fontWeight="semibold"
                whiteSpace="normal"
                textAlign="left"
                h="auto"
                minH="fit-content"
              >
                <Icon as={FaQuestionCircle} mr={2} boxSize={4} flexShrink={0} />
                <Text>{buttonText}</Text>
              </Button>
            </Tooltip>
          ) : queuesWithActiveStaff.length === 1 ? (
            <>
              <Tooltip content={tooltipText} positioning={{ placement: "bottom" }}>
                <Button
                  size="md"
                  colorPalette="green"
                  onClick={openDrawer}
                  fontWeight="semibold"
                  whiteSpace="normal"
                  textAlign="left"
                  h="auto"
                  minH="fit-content"
                >
                  <Icon as={FaQuestionCircle} mr={2} boxSize={4} flexShrink={0} />
                  <Text>{buttonText}</Text>
                </Button>
              </Tooltip>
              <Button size="md" colorPalette="green" onClick={() => handleNewRequest(queuesWithActiveStaff[0].id)}>
                <FaPlus />
                New Request
              </Button>
            </>
          ) : (
            <>
              <Tooltip content={tooltipText} positioning={{ placement: "bottom" }}>
                <Button
                  size="md"
                  colorPalette="green"
                  onClick={openDrawer}
                  fontWeight="semibold"
                  whiteSpace="normal"
                  textAlign="left"
                  h="auto"
                  minH="fit-content"
                >
                  <Icon as={FaQuestionCircle} mr={2} boxSize={4} flexShrink={0} />
                  <Text>{buttonText}</Text>
                </Button>
              </Tooltip>
              <MenuRoot>
                <MenuTrigger asChild>
                  <Button size="md" colorPalette="green">
                    <FaPlus />
                    New Request
                    <FiChevronDown />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  {queuesWithActiveStaff.map((queue) => (
                    <MenuItem key={queue.id} value={queue.id.toString()} onClick={() => handleNewRequest(queue.id)}>
                      {queue.name}
                    </MenuItem>
                  ))}
                </MenuContent>
              </MenuRoot>
            </>
          )}
        </HStack>
      </HStack>
      {isDrawerOpen && <HelpDrawer isOpen={isDrawerOpen} onClose={closeDrawer} />}
      {queuesWithActiveStaff.length === 0 ? (
        <CardRoot>
          <CardBody>
            <Text color="fg.muted" mb={4}>
              Office hours are currently closed. No staff are working on any queues right now.
            </Text>
            <HStack gap={2}>
              <Tooltip content={tooltipText} positioning={{ placement: "bottom" }}>
                <Button onClick={openDrawer} colorPalette="green" size="sm" whiteSpace="normal" textAlign="left">
                  <Icon as={FaQuestionCircle} mr={2} />
                  <Text>{buttonText}</Text>
                </Button>
              </Tooltip>
              <Button onClick={handleViewAllRequests} variant="outline" size="sm">
                View All Queues
              </Button>
            </HStack>
          </CardBody>
        </CardRoot>
      ) : (
        <Stack spaceY={4}>
          {queuesWithActiveStaff.map((queue) => {
            const queueAssignments = activeAssignmentsByQueue[queue.id] || [];
            const openRequestCount = requestCountsByQueue[queue.id] || 0;
            const activeStaffIds = queueAssignments.map((a) => a.ta_profile_id);

            return (
              <CardRoot key={queue.id}>
                <CardHeader>
                  <HStack justify="space-between" align="start" flexWrap="wrap" gap={4}>
                    <Box flex={1} minW={0}>
                      <HStack gap={2} mb={2}>
                        <Text fontWeight="semibold" fontSize="md">
                          {queue.name}
                        </Text>
                        {openRequestCount > 0 && (
                          <Badge colorPalette="blue" variant="solid">
                            {openRequestCount} {openRequestCount === 1 ? "request" : "requests"}
                          </Badge>
                        )}
                      </HStack>
                      {queue.description && (
                        <Text fontSize="sm" color="fg.muted" mb={2}>
                          {queue.description}
                        </Text>
                      )}
                      {activeStaffIds.length > 0 && (
                        <HStack gap={2} align="center" mt={2}>
                          <Text fontSize="xs" color="fg.muted">
                            Staff working:
                          </Text>
                          <HStack gap={1}>
                            {activeStaffIds.slice(0, 5).map((staffId, index) => (
                              <PersonAvatar key={`staff-${staffId}-${index}`} uid={staffId} size="sm" />
                            ))}
                            {activeStaffIds.length > 5 && (
                              <Text fontSize="xs" color="fg.muted">
                                +{activeStaffIds.length - 5} more
                              </Text>
                            )}
                          </HStack>
                        </HStack>
                      )}
                    </Box>
                    <HStack gap={2} flexShrink={0}>
                      <Button size="sm" variant="outline" onClick={() => handleViewQueue(queue.id)}>
                        View Queue
                      </Button>
                    </HStack>
                  </HStack>
                </CardHeader>
              </CardRoot>
            );
          })}
          {helpQueues.length > queuesWithActiveStaff.length && (
            <CardRoot>
              <CardBody>
                <Text fontSize="sm" color="fg.muted" mb={2}>
                  There are {helpQueues.length - queuesWithActiveStaff.length} more queue
                  {helpQueues.length - queuesWithActiveStaff.length !== 1 ? "s" : ""} available, but no staff are
                  currently working on them.
                </Text>
                <Button size="sm" variant="outline" onClick={handleViewAllRequests}>
                  View All Queues
                </Button>
              </CardBody>
            </CardRoot>
          )}
        </Stack>
      )}
    </Box>
  );
}
