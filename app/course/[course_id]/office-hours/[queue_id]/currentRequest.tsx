"use client";

import { DataList, Flex, HStack, Badge, Icon, Text } from "@chakra-ui/react";
import { Box } from "@chakra-ui/react";
import { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { useUserProfile } from "@/hooks/useUserProfiles";
import HelpRequestChat from "@/components/help-queue/help-request-chat";
import { BsPersonCheck, BsPersonDash } from "react-icons/bs";
import { useMemo } from "react";

export default function CurrentRequest({ request, position }: { request: HelpRequest; position: number }) {
  const assignee = useUserProfile(request.assignee);

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
    <Box width="100%">
      <DataList.Root>
        <DataList.Item>
          <DataList.ItemLabel>Your position in the queue</DataList.ItemLabel>
          <DataList.ItemValue>{positionDisplay}</DataList.ItemValue>
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

      <Flex height="100vh" overflow="hidden" width="100%">
        <HelpRequestChat request={request} />
      </Flex>
    </Box>
  );
}
