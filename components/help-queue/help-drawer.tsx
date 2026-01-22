"use client";

import { QueueCard } from "@/components/help-queue/queue-card";
import { RequestRow } from "@/components/help-queue/request-row";
import {
  DrawerBackdrop,
  DrawerBody,
  DrawerCloseTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerRoot,
  DrawerTitle
} from "@/components/ui/drawer";
import {
  useHelpQueueAssignments,
  useHelpQueues,
  useHelpRequests,
  useHelpRequestStudents
} from "@/hooks/useOfficeHoursRealtime";
import { useActiveHelpRequest } from "@/hooks/useActiveHelpRequest";
import { Badge, Box, Button, Heading, HStack, Stack, Text } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FaPlus } from "react-icons/fa";

interface HelpDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

function HelpDrawer({ isOpen, onClose }: HelpDrawerProps) {
  const { course_id } = useParams();
  const router = useRouter();
  const activeRequest = useActiveHelpRequest();

  const allHelpQueues = useHelpQueues();
  const allHelpQueueAssignments = useHelpQueueAssignments();
  const allHelpRequests = useHelpRequests();
  const helpRequestStudents = useHelpRequestStudents();

  const [selectedQueueId, setSelectedQueueId] = useState<number | null>(null);

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

  // Get requests for selected queue
  const selectedQueueRequests = useMemo(() => {
    if (!selectedQueueId) return [];
    return activeHelpRequests.filter((r) => r.help_queue === selectedQueueId);
  }, [activeHelpRequests, selectedQueueId]);

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

  // Auto-select first queue with active staff if none selected
  useEffect(() => {
    if (!selectedQueueId && queuesWithActiveStaff.length > 0) {
      setSelectedQueueId(queuesWithActiveStaff[0].id);
    }
  }, [selectedQueueId, queuesWithActiveStaff]);

  const handleNewRequest = (queueId: number) => {
    router.push(`/course/${course_id}/office-hours/${queueId}/new`);
    onClose();
  };

  const handleViewQueue = (queueId: number) => {
    router.push(`/course/${course_id}/office-hours?view=browse&queue=${queueId}`);
    onClose();
  };

  const handleViewRequest = (queueId: number, requestId: number) => {
    router.push(`/course/${course_id}/office-hours/${queueId}/${requestId}`);
    onClose();
  };

  return (
    <DrawerRoot open={isOpen} onOpenChange={(e) => !e.open && onClose()} size="md" placement="end">
      <DrawerBackdrop />
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Get Help</DrawerTitle>
          <DrawerCloseTrigger />
        </DrawerHeader>
        <DrawerBody>
          <Stack spaceY={4}>
            {/* Active Request Status */}
            {activeRequest && (
              <Box p={4} borderWidth="1px" borderColor="border.emphasized" bg="bg.subtle" rounded="md">
                <HStack justify="space-between" mb={2}>
                  <Text fontWeight="semibold">Your Active Request</Text>
                  <Badge
                    colorPalette={activeRequest.request.status === "in_progress" ? "orange" : "blue"}
                    variant="solid"
                  >
                    {activeRequest.request.status === "in_progress" ? "In Progress" : "Open"}
                  </Badge>
                </HStack>
                <Text fontSize="sm" color="fg.muted" mb={3}>
                  Position #{activeRequest.queuePosition} in {activeRequest.queueName}
                </Text>
                <Button
                  size="sm"
                  onClick={() => handleViewRequest(activeRequest.request.help_queue, activeRequest.request.id)}
                >
                  View Request
                </Button>
              </Box>
            )}

            {/* Queue Status */}
            <Box>
              <Heading size="md" mb={3}>
                Available Queues
              </Heading>
              {queuesWithActiveStaff.length === 0 ? (
                <Box p={4} borderWidth="1px" borderColor="border.muted" rounded="md" bg="bg.panel">
                  <Text color="fg.muted" mb={3}>
                    No staff are currently working on any queues. Office hours may be closed.
                  </Text>
                  <Button size="sm" variant="outline" onClick={() => handleViewQueue(helpQueues[0]?.id || 0)}>
                    View All Queues
                  </Button>
                </Box>
              ) : (
                <Stack spaceY={2}>
                  {queuesWithActiveStaff.map((queue) => {
                    const queueAssignments = activeAssignmentsByQueue[queue.id] || [];
                    const openRequestCount = activeHelpRequests.filter((r) => r.help_queue === queue.id).length;
                    const isSelected = selectedQueueId === queue.id;

                    return (
                      <Box key={queue.id}>
                        <QueueCard
                          queue={queue}
                          selected={isSelected}
                          onClickAction={() => setSelectedQueueId(isSelected ? null : queue.id)}
                          openRequestCount={openRequestCount}
                          activeAssignments={queueAssignments}
                        />
                        {isSelected && (
                          <Box mt={2} ml={8}>
                            <HStack gap={2} mb={2}>
                              <Button size="sm" colorPalette="green" onClick={() => handleNewRequest(queue.id)}>
                                <FaPlus />
                                New Request
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => handleViewQueue(queue.id)}>
                                View Full Queue
                              </Button>
                            </HStack>
                            {selectedQueueRequests.length > 0 && (
                              <Box mt={3}>
                                <Text fontSize="sm" fontWeight="medium" mb={2} color="fg.muted">
                                  Public Open Requests ({selectedQueueRequests.length})
                                </Text>
                                <Stack spaceY={1}>
                                  {selectedQueueRequests
                                    .filter((r) => !r.is_private)
                                    .slice(0, 5)
                                    .map((request) => {
                                      const students = requestStudentsMap[request.id] || [];
                                      return (
                                        <Box
                                          key={request.id}
                                          p={2}
                                          borderWidth="1px"
                                          borderColor="border.muted"
                                          rounded="md"
                                          cursor="pointer"
                                          _hover={{ bg: "bg.subtle" }}
                                          onClick={() => handleViewRequest(request.help_queue, request.id)}
                                        >
                                          <RequestRow request={request} href="#" queue={queue} students={students} />
                                        </Box>
                                      );
                                    })}
                                  {selectedQueueRequests.filter((r) => !r.is_private).length > 5 && (
                                    <Text fontSize="xs" color="fg.muted" textAlign="center" mt={1}>
                                      ...and {selectedQueueRequests.filter((r) => !r.is_private).length - 5} more
                                    </Text>
                                  )}
                                </Stack>
                              </Box>
                            )}
                          </Box>
                        )}
                      </Box>
                    );
                  })}
                </Stack>
              )}
            </Box>
          </Stack>
        </DrawerBody>
      </DrawerContent>
    </DrawerRoot>
  );
}

export default HelpDrawer;
export { HelpDrawer };
