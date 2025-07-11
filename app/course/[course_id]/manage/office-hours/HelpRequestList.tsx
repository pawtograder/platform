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
import type { Database } from "@/utils/supabase/SupabaseTypes";

type HelpRequestStudent = Database["public"]["Tables"]["help_request_students"]["Row"];

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

  const { data } = useList<HelpRequest>({
    resource: "help_requests",
    filters,
    pagination: { pageSize: 1000 }, // Fetch all requests like the student view
    sorters: [{ field: "created_at", order: "desc" }] // Sort by newest first for instructor view
  });

  // Fetch help request students to get the students associated with each request
  const { data: helpRequestStudentsData } = useList<HelpRequestStudent>({
    resource: "help_request_students",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    pagination: { pageSize: 1000 }
  });

  // Fetch all help queues for the class
  const { data: helpQueuesData } = useList<HelpQueue>({
    resource: "help_queues",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    pagination: { pageSize: 1000 }
  });

  const requests = data?.data;

  // Create a mapping of help request ID to student profile IDs
  const requestStudentsMap = useMemo(() => {
    const helpRequestStudents = helpRequestStudentsData?.data ?? [];
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
  }, [helpRequestStudentsData?.data]);

  // Create a mapping of queue ID to queue data
  const queueMap = useMemo(() => {
    const helpQueues = helpQueuesData?.data || [];
    return helpQueues.reduce(
      (acc, queue) => {
        acc[queue.id] = queue;
        return acc;
      },
      {} as Record<number, HelpQueue>
    );
  }, [helpQueuesData?.data]);

  // Enhanced requests with queue information and students
  const enhancedRequests = useMemo(() => {
    if (!requests) return [];

    return requests.map(
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
  }, [requests, queueMap, requestStudentsMap]);

  return (
    <Flex height="100vh" overflow="hidden">
      <Stack spaceY="4" width="320px" borderEndWidth="1px" pt="6">
        <Box px="5">
          <Text fontSize="lg" fontWeight="medium">
            Requests ({requests?.length})
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
