"use client";

import HelpRequestChat from "@/components/help-queue/help-request-chat";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Box, HStack, Stack, Text, Card, Badge, Button, Icon } from "@chakra-ui/react";
import { useState } from "react";
import { BsChevronDown, BsChevronUp, BsPersonCheck, BsPersonDash, BsReply, BsPeople } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useRouter, useParams } from "next/navigation";
import Markdown from "@/components/ui/markdown";

/**
 * Office hours UI component prop types
 */
export type HelpRequestHistoryProps = {
  requests: HelpRequest[];
  showPrivacyIndicator?: boolean;
  readOnly?: boolean;
  requestCollaborators?: Map<number, Array<{ profile_id: string; class_id: number }>>;
  userRequestIds?: number[];
  sortOrder?: "oldest" | "newest";
};

/**
 * Component to display assignment status for a help request
 */
function RequestAssignmentStatus({ request }: { request: HelpRequest }) {
  const assignee = useUserProfile(request.assignee);

  if (request.assignee && assignee) {
    return (
      <Badge colorPalette="green" variant="solid" size="sm">
        <Icon as={BsPersonCheck} mr={1} />
        Assigned to {assignee.name}
      </Badge>
    );
  } else if (request.assignee) {
    return (
      <Badge colorPalette="green" variant="solid" size="sm">
        <Icon as={BsPersonCheck} mr={1} />
        Assigned
      </Badge>
    );
  } else {
    return (
      <Badge colorPalette="gray" variant="outline" size="sm">
        <Icon as={BsPersonDash} mr={1} />
        Not Assigned
      </Badge>
    );
  }
}

/**
 * Component to display collaborator information for multi-student help requests
 */
function RequestCollaborators({
  requestId,
  collaborators
}: {
  requestId: number;
  collaborators?: Map<number, Array<{ profile_id: string; class_id: number }>>;
}) {
  const requestCollaborators = collaborators?.get(requestId);

  if (!requestCollaborators || requestCollaborators.length === 0) {
    return null;
  }

  const collaboratorCount = requestCollaborators.length;

  return (
    <Badge colorPalette="purple" variant="outline" size="sm">
      <Icon as={BsPeople} mr={1} />
      {collaboratorCount === 1 ? "1 collaborator" : `${collaboratorCount} collaborators`}
    </Badge>
  );
}

export default function HelpRequestHistory({
  requests,
  showPrivacyIndicator = false,
  readOnly = true,
  requestCollaborators,
  userRequestIds = [],
  sortOrder = "oldest"
}: HelpRequestHistoryProps) {
  const [expandedRequest, setExpandedRequest] = useState<number | null>(null);
  const router = useRouter();
  const { course_id, queue_id } = useParams();

  const toggleExpanded = (e: React.MouseEvent, requestId: number) => {
    e.stopPropagation();
    setExpandedRequest(expandedRequest === requestId ? null : requestId);
  };

  const expandOnly = (e: React.MouseEvent, requestId: number) => {
    e.stopPropagation();
    if (expandedRequest !== requestId) {
      setExpandedRequest(requestId);
    }
  };

  const handleCreateFollowup = (e: React.MouseEvent, requestId: number) => {
    e.stopPropagation();
    router.push(`/course/${course_id}/office-hours/${queue_id}/new?&followup_to=${requestId}`);
  };

  if (requests.length === 0) {
    return (
      <Card.Root>
        <Card.Body>
          <Text textAlign="center">No help requests found.</Text>
        </Card.Body>
      </Card.Root>
    );
  }

  return (
    <Stack spaceY={4}>
      <Text fontSize="lg" fontWeight="medium">
        {`Help Requests (${requests.length})`}
      </Text>
      <Stack spaceY={4} role="list" aria-label="Help requests">
        {requests
          .sort((a, b) => {
            // Sort by resolved_at if available, otherwise by created_at
            const dateA = new Date(a.resolved_at || a.created_at).getTime();
            const dateB = new Date(b.resolved_at || b.created_at).getTime();
            return sortOrder === "newest" ? dateB - dateA : dateA - dateB;
          })
          .map((request) => (
            <Card.Root
              key={request.id}
              variant="outline"
              cursor="pointer"
              role="listitem"
              aria-label={`Help request ${request.id}`}
              _hover={{ borderColor: "border.emphasized" }}
              onClick={(e) => expandOnly(e, request.id)}
            >
              <Card.Body>
                <HStack justify="space-between" align="start">
                  <Box flex="1">
                    <Markdown>{request.request}</Markdown>
                    <HStack mt={2} gap={2} wrap="wrap">
                      <Badge
                        colorPalette={
                          request.status === "resolved"
                            ? "green"
                            : request.status === "in_progress"
                              ? "orange"
                              : request.status === "closed"
                                ? "gray"
                                : "blue"
                        }
                        size="sm"
                      >
                        {request.status}
                      </Badge>
                      <RequestAssignmentStatus request={request} />
                      <RequestCollaborators requestId={request.id} collaborators={requestCollaborators} />
                      {request.location_type && (
                        <Badge colorPalette="blue" size="sm">
                          {request.location_type}
                        </Badge>
                      )}
                      {(showPrivacyIndicator || request.is_private) && request.is_private && (
                        <Badge colorPalette="orange" size="sm">
                          private
                        </Badge>
                      )}
                    </HStack>
                  </Box>
                  <Stack align="end" spaceY={1}>
                    <Text fontSize="xs">
                      {formatDistanceToNow(new Date(request.resolved_at || request.created_at), { addSuffix: true })}
                    </Text>
                    <HStack gap={2}>
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="blue"
                        onClick={(e) => handleCreateFollowup(e, request.id)}
                        title="Create a follow-up request"
                        visibility={readOnly && userRequestIds.includes(request.id) ? "visible" : "hidden"}
                      >
                        <Icon as={BsReply} mr={1} />
                        Follow-Up
                      </Button>
                      <Button size="xs" variant="ghost" onClick={(e) => toggleExpanded(e, request.id)}>
                        {expandedRequest === request.id ? "Hide" : "View"} Chat
                        <Icon as={expandedRequest === request.id ? BsChevronUp : BsChevronDown} ml={1} />
                      </Button>
                    </HStack>
                  </Stack>
                </HStack>

                {expandedRequest === request.id && (
                  <Box mt={4} pt={4} borderTopWidth="1px">
                    <HelpRequestChat request={request} />
                  </Box>
                )}
              </Card.Body>
            </Card.Root>
          ))}
      </Stack>
    </Stack>
  );
}
