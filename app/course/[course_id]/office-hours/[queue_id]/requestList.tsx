"use client";

import HelpRequestChat from "@/components/ui/help-queue/help-request-chat";
import { HelpRequest, HelpRequestHistoryProps } from "@/utils/supabase/DatabaseTypes";
import { Box, HStack, Stack, Text, Card, Badge, Button, Icon } from "@chakra-ui/react";
import { useState } from "react";
import { BsChevronDown, BsChevronUp, BsPersonCheck, BsPersonDash } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";
import { useUserProfile } from "@/hooks/useUserProfiles";

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

export default function HelpRequestHistory({ requests, showPrivacyIndicator = false }: HelpRequestHistoryProps) {
  const [expandedRequest, setExpandedRequest] = useState<number | null>(null);

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
      <Stack spaceY={4}>
        {requests
          .sort((a, b) => {
            // Sort by resolved_at if available, otherwise by created_at
            const dateA = new Date(a.resolved_at || a.created_at).getTime();
            const dateB = new Date(b.resolved_at || b.created_at).getTime();
            return dateA - dateB;
          })
          .map((request) => (
            <Card.Root
              key={request.id}
              variant="outline"
              cursor="pointer"
              _hover={{ borderColor: "border.emphasized" }}
              onClick={(e) => expandOnly(e, request.id)}
            >
              <Card.Body>
                <HStack justify="space-between" align="start">
                  <Box flex="1">
                    <Text fontWeight="medium" fontSize="sm" lineHeight="short">
                      {request.request.length > 100 ? `${request.request.substring(0, 100)}...` : request.request}
                    </Text>
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
                    <Button size="xs" variant="ghost" onClick={(e) => toggleExpanded(e, request.id)}>
                      {expandedRequest === request.id ? "Hide" : "View"} Chat
                      <Icon as={expandedRequest === request.id ? BsChevronUp : BsChevronDown} ml={1} />
                    </Button>
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
