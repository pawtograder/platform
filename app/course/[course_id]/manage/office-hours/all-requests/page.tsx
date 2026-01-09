"use client";

import { Box, Flex, Heading, Stack, Text, Badge, Separator, HStack } from "@chakra-ui/react";
import { useSearchParams, useRouter, useParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  useHelpQueues,
  useHelpQueueAssignments,
  useHelpRequests,
  useHelpRequestStudents
} from "@/hooks/useOfficeHoursRealtime";
import { QueueCard } from "@/components/help-queue/queue-card";
import { RequestRow } from "@/components/help-queue/request-row";
import {
  RequestListControls,
  type RequestStatusFilter,
  type SortDirection
} from "@/components/help-queue/request-list-controls";
import { useStudentRoster } from "@/hooks/useCourseController";

export default function AllRequestsPage() {
  const searchParams = useSearchParams();
  const selectedQueueId = searchParams.get("queue") ? Number(searchParams.get("queue")) : null;
  const { course_id } = useParams();
  const router = useRouter();
  const studentRoster = useStudentRoster();

  // Filter/sort state
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<RequestStatusFilter>("all");
  const [sortDirection, setSortDirection] = useState<SortDirection>("oldest-first");

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

  // Create mapping of profile ID to student name for search
  const studentNameMap = useMemo(() => {
    return studentRoster?.reduce(
      (acc, student) => {
        acc[student.id] = student.name || student.short_name || student.sortable_name || "Unknown Student";
        return acc;
      },
      {} as Record<string, string>
    );
  }, [studentRoster]);

  // Get requests for selected queue, filtered and sorted
  const { openRequests, resolvedRequests } = useMemo(() => {
    if (!selectedQueueId) return { openRequests: [], resolvedRequests: [] };

    let requests = allHelpRequests.filter((r) => r.help_queue === selectedQueueId);

    // Apply status filter
    if (statusFilter !== "all") {
      requests = requests.filter((r) => r.status === statusFilter);
    }

    // Apply search filter
    if (searchTerm.trim()) {
      const searchLower = searchTerm.toLowerCase();
      requests = requests.filter((request) => {
        const requestStudents = requestStudentsMap[request.id] || [];
        const requestTextMatch = request.request.toLowerCase().includes(searchLower);
        const studentNameMatch = requestStudents.some((profileId) => {
          const studentName = studentNameMap?.[profileId];
          return studentName && studentName.toLowerCase().includes(searchLower);
        });
        return requestTextMatch || studentNameMatch;
      });
    }

    // Separate into open and resolved
    const open: typeof requests = [];
    const resolved: typeof requests = [];

    requests.forEach((request) => {
      const isOpen = request.status === "open" || request.status === "in_progress";
      const isResolved = request.status === "resolved" || request.status === "closed";

      if (isOpen) {
        open.push(request);
      } else if (isResolved) {
        resolved.push(request);
      }
    });

    // Sort open requests: oldest first
    open.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    // Sort resolved requests: newest first (or oldest first if sortDirection is oldest-first)
    if (sortDirection === "oldest-first") {
      resolved.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    } else {
      resolved.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    return { openRequests: open, resolvedRequests: resolved };
  }, [allHelpRequests, selectedQueueId, statusFilter, searchTerm, requestStudentsMap, studentNameMap, sortDirection]);

  return (
    <Box height="100%" minH={0} overflow="hidden">
      <Flex direction={{ base: "column", lg: "row" }} gap={{ base: 4, lg: 6 }} align="stretch" height="100%" minH={0}>
        <Box
          flex={{ lg: 4 }}
          minW={0}
          maxW={{ lg: "320px" }}
          overflowY="auto"
          minH={0}
          maxH={{ base: "40vh", lg: "100%" }}
        >
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
            flexGrow={1}
          >
            {selectedQueueId ? (
              <>
                <RequestListControls
                  searchTerm={searchTerm}
                  onSearchChange={setSearchTerm}
                  statusFilter={statusFilter}
                  onStatusFilterChange={setStatusFilter}
                  sortDirection={sortDirection}
                  onSortDirectionChange={setSortDirection}
                />
                <Box overflowY="auto" minH={0} flex="1">
                  {/* Open Requests Section - Always show */}
                  <Box px="4" py="2" bg="blue.50" borderBottomWidth="1px" borderColor="border.muted">
                    <HStack gap="2" align="center">
                      <Text fontWeight="semibold" fontSize="sm" textTransform="uppercase" color="blue.700">
                        Open Requests
                      </Text>
                      <Badge colorPalette="blue" variant="solid" size="sm">
                        {openRequests.length}
                      </Badge>
                    </HStack>
                  </Box>
                  {openRequests.length === 0 ? (
                    <Box px="4" py="3" color="fg.muted" fontSize="sm">
                      No open requests
                    </Box>
                  ) : (
                    openRequests.map((request) => {
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
                  )}

                  {/* Separator between open and resolved */}
                  {resolvedRequests.length > 0 && (
                    <Box px="4" py="2">
                      <Separator />
                    </Box>
                  )}

                  {/* Resolved Requests Section */}
                  {resolvedRequests.length > 0 && (
                    <>
                      <Box px="4" py="2" bg="gray.50" borderBottomWidth="1px" borderColor="border.muted">
                        <HStack gap="2" align="center">
                          <Text fontWeight="semibold" fontSize="sm" textTransform="uppercase" color="gray.700">
                            Resolved Requests
                          </Text>
                          <Badge colorPalette="gray" variant="solid" size="sm">
                            {resolvedRequests.length}
                          </Badge>
                        </HStack>
                      </Box>
                      {resolvedRequests.map((request) => {
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
                    </>
                  )}
                </Box>
              </>
            ) : (
              <Box px="4" py="3" color="fg.muted" fontSize="sm">
                Select a queue to view requests.
              </Box>
            )}
          </Box>
        </Box>
      </Flex>
    </Box>
  );
}
