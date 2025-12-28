"use client";

import { RequestRow } from "@/components/help-queue/request-row";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  useHelpQueueAssignments,
  useHelpQueues,
  useHelpRequests,
  useHelpRequestStudents
} from "@/hooks/useOfficeHoursRealtime";
import { Box, Flex, Heading, Stack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import HelpQueuesDashboard from "./helpQueuesDashboard";

/**
 * Default office hours management page.
 * Shows "Working" view if user is working on queues, otherwise shows TA Dashboard.
 */
export default function OfficeHoursAdminPage() {
  const { course_id } = useParams();
  const { private_profile_id } = useClassProfiles();

  // Get data for working view
  const allHelpQueues = useHelpQueues();
  const allHelpQueueAssignments = useHelpQueueAssignments();
  const allHelpRequests = useHelpRequests();
  const helpRequestStudents = useHelpRequestStudents();

  // Filter assignments for current TA
  const activeAssignments = useMemo(() => {
    return allHelpQueueAssignments.filter(
      (assignment) => assignment.ta_profile_id === private_profile_id && assignment.is_active
    );
  }, [allHelpQueueAssignments, private_profile_id]);

  // Get queues the TA is working
  const workingQueues = useMemo(() => {
    return activeAssignments
      .map((assignment) => {
        const queue = allHelpQueues.find((q) => q.id === assignment.help_queue_id);
        return queue;
      })
      .filter(Boolean);
  }, [activeAssignments, allHelpQueues]);

  // Get requests from working queues
  const workingQueueIds = useMemo(() => {
    return new Set(workingQueues.map((q) => q?.id).filter(Boolean));
  }, [workingQueues]);

  const requestsFromWorkingQueues = useMemo(() => {
    return allHelpRequests.filter((r) => workingQueueIds.has(r.help_queue));
  }, [allHelpRequests, workingQueueIds]);

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

  // Group requests by assignment status
  const myAssignedRequests = useMemo(() => {
    return requestsFromWorkingQueues.filter(
      (r) => r.assignee === private_profile_id && (r.status === "open" || r.status === "in_progress")
    );
  }, [requestsFromWorkingQueues, private_profile_id]);

  const unassignedRequests = useMemo(() => {
    return requestsFromWorkingQueues.filter((r) => !r.assignee && r.status === "open");
  }, [requestsFromWorkingQueues]);

  // If user is working on queues, show Working view
  if (activeAssignments.length > 0) {
    return (
      <Flex direction={{ base: "column", lg: "row" }} gap={{ base: 4, lg: 6 }} align="stretch">
        <Box flex={{ lg: 8 }} minW={0}>
          <Stack spaceY={4}>
            <Heading size="md">Requests I&apos;m Responsible For</Heading>
            <Box borderWidth="1px" borderColor="border.emphasized" bg="bg.panel" rounded="md" overflow="hidden">
              {myAssignedRequests.length === 0 && unassignedRequests.length === 0 ? (
                <Box px="4" py="3">
                  <Box color="fg.muted" fontSize="sm">
                    No requests in queues you&apos;re working. Start working on a queue from the Dashboard.
                  </Box>
                </Box>
              ) : (
                <>
                  {myAssignedRequests.length > 0 && (
                    <Box>
                      <Box px="4" py="2" bg="bg.muted" borderBottomWidth="1px" borderColor="border.muted">
                        <Heading size="sm">My Assigned ({myAssignedRequests.length})</Heading>
                      </Box>
                      {myAssignedRequests.map((request) => {
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
                      })}
                    </Box>
                  )}
                  {unassignedRequests.length > 0 && (
                    <Box>
                      <Box px="4" py="2" bg="bg.muted" borderBottomWidth="1px" borderColor="border.muted">
                        <Heading size="sm">Unassigned ({unassignedRequests.length})</Heading>
                      </Box>
                      {unassignedRequests.map((request) => {
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
                      })}
                    </Box>
                  )}
                </>
              )}
            </Box>
          </Stack>
        </Box>
      </Flex>
    );
  }

  // If user is not working, show TA Dashboard
  return <HelpQueuesDashboard />;
}
