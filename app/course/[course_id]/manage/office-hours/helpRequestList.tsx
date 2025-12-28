"use client";
import { ChatGroupHeader } from "@/components/help-queue/chat-group-header";
import { HelpRequestTeaser } from "@/components/help-queue/help-request-teaser";
import { SearchInput } from "@/components/help-queue/search-input";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useStudentRoster } from "@/hooks/useCourseController";
import { HelpRequest, HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import NextLink from "next/link";
import { useParams } from "next/navigation";
import { useState, useMemo } from "react";
import { BsClipboardCheckFill, BsCheckCircle, BsXCircle, BsChatText } from "react-icons/bs";
import { useHelpRequests, useHelpQueues, useHelpRequestStudents } from "@/hooks/useOfficeHoursRealtime";

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
  const studentRoster = useStudentRoster();
  const activeRequestID = request_id ? Number.parseInt(request_id as string) : null;
  const [searchTerm, setSearchTerm] = useState("");

  // Get ALL help requests directly from the controller
  const allHelpRequestsFromController = useHelpRequests();

  // Use individual hooks for additional data
  const helpQueues = useHelpQueues();
  const realtimeHelpRequestStudents = useHelpRequestStudents();
  const officeHoursLoading = false; // Individual hooks don't expose loading state

  // Create a mapping of help request ID to student profile IDs
  const requestStudentsMap = useMemo(() => {
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

  // Create a mapping of profile ID to student name for search functionality
  const studentNameMap = useMemo(() => {
    return studentRoster?.reduce(
      (acc, student) => {
        acc[student.id] = student.name || student.short_name || student.sortable_name || "Unknown Student";
        return acc;
      },
      {} as Record<string, string>
    );
  }, [studentRoster]);

  // Apply client-side search filtering and get ALL help requests
  const allHelpRequests = useMemo(() => {
    // Apply client-side search filtering if search term exists
    if (searchTerm.trim()) {
      const searchLower = searchTerm.toLowerCase();
      return allHelpRequestsFromController.filter((request) => {
        const requestStudents = requestStudentsMap[request.id] || [];
        const requestTextMatch = request.request.toLowerCase().includes(searchLower);
        const studentNameMatch = requestStudents.some((profileId) => {
          const studentName = studentNameMap?.[profileId];
          return studentName && studentName.toLowerCase().includes(searchLower);
        });
        return requestTextMatch || studentNameMatch;
      });
    }

    return allHelpRequestsFromController;
  }, [allHelpRequestsFromController, searchTerm, requestStudentsMap, studentNameMap]);

  // Enhanced requests with queue information and students
  const enhancedRequests = useMemo(() => {
    return allHelpRequests
      .map((request): EnhancedHelpRequest => {
        // Fallback: if student associations haven't arrived yet, use the creator as the primary student
        const associatedStudents = requestStudentsMap[request.id] || [];
        const students =
          associatedStudents.length > 0 ? associatedStudents : ([request.created_by!].filter(Boolean) as string[]);
        return {
          ...request,
          queue:
            queueMap[request.help_queue] ||
            ({
              id: request.help_queue,
              name: `Queue #${request.help_queue}`,
              queue_type: "text",
              color: null
            } as HelpQueue),
          students
        };
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()); // oldest first
  }, [allHelpRequests, queueMap, requestStudentsMap]);

  // Show loading state while data is being fetched
  if (officeHoursLoading) {
    return (
      <Flex height="100vh" overflow="hidden" justify="center" align="center">
        <Text>Loading help requests...</Text>
      </Flex>
    );
  }

  return (
    <Flex height={{ base: "auto", md: "100vh" }} overflow={{ base: "visible", md: "hidden" }}>
      <Stack
        spaceY="4"
        width={{ base: "100%", md: "320px" }}
        borderEndWidth={{ base: "0px", md: "1px" }}
        borderBottomWidth={{ base: "1px", md: "0px" }}
        borderColor="border.emphasized"
        pt={{ base: "4", md: "6" }}
      >
        <Box px={{ base: "4", md: "5" }}>
          <Text fontSize="lg" fontWeight="medium">
            Requests ({enhancedRequests?.length || 0})
          </Text>
        </Box>

        <Box px={{ base: "4", md: "5" }}>
          <SearchInput value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
        </Box>

        <Stack
          spaceY="6"
          flex={{ base: "0 0 auto", md: "1 1 auto" }}
          overflowY={{ base: "visible", md: "auto" }}
          px={{ base: "4", md: "5" }}
          pb={{ base: "4", md: "5" }}
          pt={{ base: "2", md: "2" }}
        >
          <ChatGroupHeader
            icon={BsClipboardCheckFill}
            title="Working"
            count={
              enhancedRequests.filter((r) => r.status === "in_progress" && r.assignee === private_profile_id).length
            }
          >
            <Stack spaceY="0" mx="-4" mt="4" role="list" aria-label="Working help requests">
              {enhancedRequests
                .filter((r) => r.status === "in_progress" && r.assignee === private_profile_id)
                .map((request) => (
                  <NextLink
                    href={`/course/${course_id}/manage/office-hours/request/${request.id}`}
                    key={request.id}
                    aria-label={request.request}
                  >
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
            <Stack spaceY="0" mx="-4" mt="4" role="list" aria-label="Unassigned help requests">
              {enhancedRequests
                .filter((r) => r.status === "open")
                .map((request) => (
                  <NextLink
                    href={`/course/${course_id}/manage/office-hours/request/${request.id}`}
                    key={request.id}
                    aria-label={request.request}
                  >
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
            <Stack spaceY="0" mx="-4" mt="4" role="list" aria-label="Resolved help requests">
              {enhancedRequests
                .filter((r) => r.status === "resolved")
                .map((request) => (
                  <NextLink
                    href={`/course/${course_id}/manage/office-hours/request/${request.id}`}
                    key={request.id}
                    aria-label={request.request}
                  >
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
            <Stack spaceY="0" mx="-4" mt="4" role="list" aria-label="Closed help requests">
              {enhancedRequests
                .filter((r) => r.status === "closed")
                .map((request) => (
                  <NextLink
                    href={`/course/${course_id}/manage/office-hours/request/${request.id}`}
                    key={request.id}
                    aria-label={request.request}
                  >
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
