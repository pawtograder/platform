"use client";
import { ChatGroupHeader } from "@/components/ui/help-queue/ChatGroupHeader";
import { HelpRequestTeaser } from "@/components/ui/help-queue/HelpRequestTeaser";
import { SearchInput } from "@/components/ui/help-queue/SearchInput";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { useList, CrudFilters } from "@refinedev/core";
import NextLink from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { BsChatTextFill, BsClipboardCheckFill, BsCheckCircle, BsXCircle } from "react-icons/bs";

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
    filters
  });

  const requests = data?.data;

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
            count={requests?.filter((r) => r.status === "in_progress" && r.assignee === private_profile_id).length}
          >
            <Stack spaceY="0" mx="-4" mt="4">
              {requests
                ?.filter((r) => r.status === "in_progress" && r.assignee === private_profile_id)
                .map((request) => (
                  <NextLink href={`/course/${course_id}/manage/office-hours/request/${request.id}`} key={request.id}>
                    <HelpRequestTeaser
                      data={{
                        user: request.creator,
                        updatedAt: request.created_at,
                        message: request.request,
                        isResolved: request.status === "resolved" || request.status === "closed",
                        isAssigned: request.assignee === private_profile_id
                      }}
                      selected={activeRequestID === request.id}
                    />
                  </NextLink>
                ))}
            </Stack>
          </ChatGroupHeader>

          <ChatGroupHeader
            icon={BsChatTextFill}
            title="Unassigned"
            count={requests?.filter((r) => r.status === "open").length}
          >
            <Stack spaceY="0" mx="-4" mt="4">
              {requests
                ?.filter((r) => r.status === "open")
                .map((request) => (
                  <NextLink href={`/course/${course_id}/manage/office-hours/request/${request.id}`} key={request.id}>
                    <HelpRequestTeaser
                      data={{
                        user: request.creator,
                        updatedAt: request.created_at,
                        message: request.request,
                        isResolved: request.status === "resolved" || request.status === "closed",
                        isAssigned: request.assignee === private_profile_id
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
            count={requests?.filter((r) => r.status === "resolved").length}
            defaultOpen={false}
          >
            <Stack spaceY="0" mx="-4" mt="4">
              {requests
                ?.filter((r) => r.status === "resolved")
                .map((request) => (
                  <NextLink href={`/course/${course_id}/manage/office-hours/request/${request.id}`} key={request.id}>
                    <HelpRequestTeaser
                      data={{
                        user: request.creator,
                        updatedAt: request.created_at,
                        message: request.request,
                        isResolved: true,
                        isAssigned: request.assignee === private_profile_id
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
            count={requests?.filter((r) => r.status === "closed").length}
            defaultOpen={false}
          >
            <Stack spaceY="0" mx="-4" mt="4">
              {requests
                ?.filter((r) => r.status === "closed")
                .map((request) => (
                  <NextLink href={`/course/${course_id}/manage/office-hours/request/${request.id}`} key={request.id}>
                    <HelpRequestTeaser
                      data={{
                        user: request.creator,
                        updatedAt: request.created_at,
                        message: request.request,
                        isResolved: true,
                        isAssigned: request.assignee === private_profile_id
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
