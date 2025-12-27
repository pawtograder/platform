"use client";

import { Box, Flex, Heading, Stack } from "@chakra-ui/react";
import { useSearchParams, useRouter, useParams } from "next/navigation";
import { useMemo } from "react";
import {
  useHelpQueues,
  useHelpQueueAssignments,
  useHelpRequests,
  useHelpRequestStudents
} from "@/hooks/useOfficeHoursRealtime";
import { QueueCard } from "@/components/help-queue/queue-card";
import { RequestRow } from "@/components/help-queue/request-row";

export default function AllRequestsPage() {
  const searchParams = useSearchParams();
  const selectedQueueId = searchParams.get("queue") ? Number(searchParams.get("queue")) : null;
  const { course_id } = useParams();
  const router = useRouter();

  // Get data for all-requests view
  const allHelpQueues = useHelpQueues();
  const allHelpQueueAssignments = useHelpQueueAssignments();
  const allHelpRequests = useHelpRequests();
  const helpRequestStudents = useHelpRequestStudents();

  // Group active assignments by queue
  const activeAssignmentsByQueue = useMemo(() => {
    return allHelpQueueAssignments
      .filter((assignment) => assignment.is_active)
      .reduce(
        (acc, assignment) => {
          const queueId = assignment.help_queue_id;
          if (!acc[queueId]) {
            acc[queueId] = [];
          }
          acc[queueId].push(assignment);
          return acc;
        },
        {} as Record<number, typeof allHelpQueueAssignments>
      );
  }, [allHelpQueueAssignments]);

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

  // Get requests for selected queue
  const selectedQueueRequests = useMemo(() => {
    if (!selectedQueueId) return [];
    return allHelpRequests.filter((r) => r.help_queue === selectedQueueId);
  }, [allHelpRequests, selectedQueueId]);

  return (
    <Box height={{ base: "auto", lg: "100%" }} minH={0} overflow={{ base: "visible", lg: "hidden" }}>
      <Flex direction={{ base: "column", lg: "row" }} gap={{ base: 4, lg: 6 }} align="stretch" height="100%" minH={0}>
        <Box flex={{ lg: 4 }} minW={0} overflowY={{ base: "visible", lg: "auto" }} minH={0}>
          <Stack spaceY={1}>
            {allHelpQueues.map((queue) => {
              const queueAssignments = activeAssignmentsByQueue[queue.id] || [];
              const openRequestCount = allHelpRequests
                .filter((r) => r.status === "open" || r.status === "in_progress")
                .filter((r) => r.help_queue === queue.id).length;
              return (
                <QueueCard
                  key={queue.id}
                  queue={queue}
                  selected={queue.id === selectedQueueId}
                  onClickAction={() => {
                    const next = new URLSearchParams(searchParams.toString());
                    next.set("queue", queue.id.toString());
                    router.replace(`/course/${course_id}/manage/office-hours/all-requests?${next.toString()}`, {
                      scroll: false
                    });
                  }}
                  openRequestCount={openRequestCount}
                  activeAssignments={queueAssignments}
                />
              );
            })}
          </Stack>
        </Box>

        <Box flex={{ lg: 8 }} minW={0} minH={0} display="flex" flexDirection="column">
          <Heading size="md" mb="4" flexShrink={0}>
            {selectedQueueId
              ? allHelpQueues.find((q) => q.id === selectedQueueId)?.name || "Select a queue"
              : "Select a queue"}
          </Heading>

          <Box
            borderWidth="1px"
            borderColor="border.emphasized"
            bg="bg.panel"
            rounded="md"
            overflow="hidden"
            minH={0}
            display="flex"
            flexDirection="column"
          >
            <Box overflowY={{ base: "visible", lg: "auto" }} minH={0}>
              {selectedQueueId && selectedQueueRequests.length === 0 ? (
                <Box px="4" py="3" color="fg.muted" fontSize="sm">
                  No requests in this queue.
                </Box>
              ) : selectedQueueId ? (
                selectedQueueRequests.map((request) => {
                  const queue = allHelpQueues.find((q) => q.id === request.help_queue);
                  const students = requestStudentsMap[request.id] || [];
                  return (
                    <RequestRow
                      key={request.id}
                      request={request}
                      href={`/course/${course_id}/manage/office-hours/request/${request.id}`}
                      queue={queue}
                      students={students}
                    />
                  );
                })
              ) : (
                <Box px="4" py="3" color="fg.muted" fontSize="sm">
                  Select a queue to view requests.
                </Box>
              )}
            </Box>
          </Box>
        </Box>
      </Flex>
    </Box>
  );
}
