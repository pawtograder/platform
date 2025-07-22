"use client";
import { ChatGroupHeader } from "@/components/ui/help-queue/chat-group-header";
import { HelpRequestTeaser } from "@/components/ui/help-queue/help-request-teaser";
import { SearchInput } from "@/components/ui/help-queue/search-input";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { HelpRequest, HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { useList, CrudFilters } from "@refinedev/core";
import NextLink from "next/link";
import { useParams } from "next/navigation";
import { useState, useMemo } from "react";
import { BsClipboardCheckFill, BsCheckCircle, BsXCircle, BsChatText } from "react-icons/bs";
import { useOfficeHoursRealtime } from "@/hooks/useOfficeHoursRealtime";

/**
 * Enhanced help request with queue information and multiple students
 */
type EnhancedHelpRequest = HelpRequest & {
  queue: HelpQueue;
  students: string[];
};

export default function HelpRequestList() {
  const { course_id, request_id } = useParams();
  const { private_profile_id } = useClassProfiles();
  const activeRequestID = request_id ? Number.parseInt(request_id as string) : null;
  const [searchTerm, setSearchTerm] = useState("");

  // Use the consolidated office hours realtime hook for most data
  const { data: officeHoursData, isLoading: officeHoursLoading } = useOfficeHoursRealtime({
    classId: Number(course_id),
    enableGlobalQueues: true, // Need queues data
    enableActiveRequests: true, // Need all help requests
    enableStaffData: false // Don't need moderation/karma data for this view
  });

  // Extract data from the consolidated hook
  const { helpQueues, helpRequestStudents: realtimeHelpRequestStudents } = officeHoursData;

  // Still need to fetch all help requests (not just active) with search capability
  // Build filters array dynamically
  const filters: CrudFilters = [{ field: "class_id", operator: "eq", value: course_id }];

  // Add search filter if search term exists
  if (searchTerm.trim()) {
    filters.push({
      field: "request",
      operator: "contains",
      value: searchTerm
    });
  }

  const { data: searchableRequestsData, isLoading: searchLoading } = useList<HelpRequest>({
    resource: "help_requests",
    filters,
    pagination: { pageSize: 1000 }, // Fetch all requests like the student view
    sorters: [{ field: "created_at", order: "desc" }] // Sort by newest first for instructor view
  });

  // Use searchable requests if there's a search term, otherwise use realtime data
  const allHelpRequests = useMemo(() => {
    if (searchTerm.trim()) {
      return searchableRequestsData?.data || [];
    }
    // For non-search case, we need to fetch all requests, not just active ones
    // So we'll fall back to the searchable data without search filter
    return searchableRequestsData?.data || [];
  }, [searchTerm, searchableRequestsData?.data]);

  // Create a mapping of help request ID to student profile IDs
  const requestStudentsMap = useMemo(() => {
    // Use realtime data when available, fall back to empty array
    return realtimeHelpRequestStudents.reduce(
      (acc, student) => {
        if (!acc[student.help_request_id]) {
          acc[student.help_request_id] = [];
        }
        acc[student.help_request_id].push(student.profile_id);
        return acc;
      },
      {} as Record<number, string[]>
    );
  }, [realtimeHelpRequestStudents]);

  // Create a mapping of queue ID to queue data
  const queueMap = useMemo(() => {
    return helpQueues.reduce(
      (acc, queue) => {
        acc[queue.id] = queue;
        return acc;
      },
      {} as Record<number, HelpQueue>
    );
  }, [helpQueues]);

  // Enhanced requests with queue information and students
  const enhancedRequests = useMemo(() => {
    return allHelpRequests.map(
      (request): EnhancedHelpRequest => ({
        ...request,
        queue:
          queueMap[request.help_queue] ||
          ({
            id: request.help_queue,
            name: `Queue #${request.help_queue}`,
            queue_type: "text",
            color: null
          } as HelpQueue),
        students: requestStudentsMap[request.id] || []
      })
    );
  }, [allHelpRequests, queueMap, requestStudentsMap]);

  // Show loading state while data is being fetched
  if (officeHoursLoading || searchLoading) {
    return (
      <Flex height="100vh" overflow="hidden" justify="center" align="center">
        <Text>Loading help requests...</Text>
      </Flex>
    );
  }

  return (
    <Flex height="100vh" overflow="hidden">
      <Stack spaceY="4" width="320px" borderEndWidth="1px" pt="6">
        <Box px="5">
          <Text fontSize="lg" fontWeight="medium">
            Requests ({allHelpRequests?.length || 0})
          </Text>
        </Box>

        <Box px="5">
          <SearchInput value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
        </Box>

        <Stack spaceY="6" flex="1" overflowY="auto" px="5" pb="5" pt="2">
          <ChatGroupHeader
            icon={BsClipboardCheckFill}
            title="Working"
            count={
              enhancedRequests.filter((r) => r.status === "in_progress" && r.assignee === private_profile_id).length
            }
          >
            <Stack spaceY="0" mx="-4" mt="4">
              {enhancedRequests
                .filter((r) => r.status === "in_progress" && r.assignee === private_profile_id)
                .map((request) => (
                  <NextLink href={`/course/${course_id}/manage/office-hours/request/${request.id}`} key={request.id}>
                    <HelpRequestTeaser
                      data={{
                        user: request.students[0] || "unknown",
                        updatedAt: request.created_at,
                        message: request.request,
                        isResolved: request.status === "resolved" || request.status === "closed",
                        isAssigned: request.assignee === private_profile_id,
                        students: request.students,
                        queue: request.queue,
                        isVideoLive: request.is_video_live
                      }}
                      selected={activeRequestID === request.id}
                    />
                  </NextLink>
                ))}
            </Stack>
          </ChatGroupHeader>

          <ChatGroupHeader
            icon={BsChatText}
            title="Unassigned"
            count={enhancedRequests.filter((r) => r.status === "open").length}
          >
            <Stack spaceY="0" mx="-4" mt="4">
              {enhancedRequests
                .filter((r) => r.status === "open")
                .map((request) => (
                  <NextLink href={`/course/${course_id}/manage/office-hours/request/${request.id}`} key={request.id}>
                    <HelpRequestTeaser
                      data={{
                        user: request.students[0] || "unknown",
                        updatedAt: request.created_at,
                        message: request.request,
                        isResolved: false,
                        isAssigned: false,
                        students: request.students,
                        queue: request.queue,
                        isVideoLive: request.is_video_live
                      }}
                      selected={activeRequestID === request.id}
                    />
                  </NextLink>
                ))}
            </Stack>
          </ChatGroupHeader>

          <ChatGroupHeader
            icon={BsCheckCircle}
            title="Resolved"
            count={enhancedRequests.filter((r) => r.status === "resolved").length}
            defaultOpen={false}
          >
            <Stack spaceY="0" mx="-4" mt="4">
              {enhancedRequests
                .filter((r) => r.status === "resolved")
                .map((request) => (
                  <NextLink href={`/course/${course_id}/manage/office-hours/request/${request.id}`} key={request.id}>
                    <HelpRequestTeaser
                      data={{
                        user: request.students[0] || "unknown",
                        updatedAt: request.created_at,
                        message: request.request,
                        isResolved: true,
                        isAssigned: request.assignee === private_profile_id,
                        students: request.students,
                        queue: request.queue,
                        isVideoLive: request.is_video_live
                      }}
                      selected={activeRequestID === request.id}
                    />
                  </NextLink>
                ))}
            </Stack>
          </ChatGroupHeader>

          <ChatGroupHeader
            icon={BsXCircle}
            title="Closed"
            count={enhancedRequests.filter((r) => r.status === "closed").length}
            defaultOpen={false}
          >
            <Stack spaceY="0" mx="-4" mt="4">
              {enhancedRequests
                .filter((r) => r.status === "closed")
                .map((request) => (
                  <NextLink href={`/course/${course_id}/manage/office-hours/request/${request.id}`} key={request.id}>
                    <HelpRequestTeaser
                      data={{
                        user: request.students[0] || "unknown",
                        updatedAt: request.created_at,
                        message: request.request,
                        isResolved: true,
                        isAssigned: request.assignee === private_profile_id,
                        students: request.students,
                        queue: request.queue,
                        isVideoLive: request.is_video_live
                      }}
                      selected={activeRequestID === request.id}
                    />
                  </NextLink>
                ))}
            </Stack>
          </ChatGroupHeader>
        </Stack>
      </Stack>
    </Flex>
  );
}
