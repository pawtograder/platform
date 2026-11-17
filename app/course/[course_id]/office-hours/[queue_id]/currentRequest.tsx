"use client";

import { DataList, Flex, HStack, Badge, Icon, Text } from "@chakra-ui/react";
import { Box } from "@chakra-ui/react";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import HelpRequestChat from "@/components/help-queue/help-request-chat";
import { BsPersonCheck, BsPersonDash } from "react-icons/bs";
import { useMemo } from "react";
import { Alert } from "@/components/ui/alert";
import { EscalationBadge } from "@/components/help-queue/escalation-badge";

export default function CurrentRequest({ request, position }: { request: HelpRequest; position: number }) {
  const assignee = useUserProfile(request.assignee);

  // Check if request is active (not resolved/closed)
  const isActive = request.status === "open" || request.status === "in_progress";

  // Memoize position display to prevent unnecessary recalculations
  const positionDisplay = useMemo(() => {
    return position > 0 ? position : "-";
  }, [position]);

  // Memoize assignment status to prevent unnecessary recalculations
  const assignmentStatus = useMemo(() => {
    if (assignee) {
      return {
        badge: (
          <Badge colorPalette="green" variant="solid" fontSize="sm">
            <Icon as={BsPersonCheck} mr={1} />
            Assigned
          </Badge>
        ),
        text: `${assignee.name} is working on this`
      };
    } else {
      return {
        badge: (
          <Badge colorPalette="gray" variant="outline" fontSize="sm">
            <Icon as={BsPersonDash} mr={1} />
            Not Assigned
          </Badge>
        ),
        text: "Waiting for a TA/instructor to pick this up"
      };
    }
  }, [assignee]);

  return (
    <Box width="100%" maxW={{ base: "md", md: "full" }} mx="auto">
      {/* Only show metadata for active requests */}
      {isActive && (
        <DataList.Root>
          <DataList.Item>
            <DataList.ItemLabel>Your position in the queue</DataList.ItemLabel>
            <DataList.ItemValue>
              <HStack gap={2}>
                <Text>{positionDisplay}</Text>
                <EscalationBadge escalationCount={request.escalation_count} />
              </HStack>
            </DataList.ItemValue>
          </DataList.Item>
          <DataList.Item>
            <DataList.ItemLabel>Assignment Status:</DataList.ItemLabel>
            <DataList.ItemValue>
              <HStack gap={2}>
                {assignmentStatus.badge}
                <Text fontSize="sm" fontWeight="medium" color={assignee ? "fg.default" : "fg.muted"}>
                  {assignmentStatus.text}
                </Text>
              </HStack>
            </DataList.ItemValue>
          </DataList.Item>
        </DataList.Root>
      )}
      {request.status === "open" && request.escalation_count > 0 && (
        <Alert status="info" title="You're ahead of new requests" mt={3}>
          Your request was escalated, so the next available TA will see it before normal requests, along with what was
          already covered.
        </Alert>
      )}

      <Flex
        height={{ base: "auto", md: "100vh" }}
        overflow={{ base: "visible", md: "hidden" }}
        width="100%"
        maxW={{ base: "md", md: "full" }}
        mx="auto"
      >
        <HelpRequestChat request_id={request.id} />
      </Flex>
    </Box>
  );
}
