"use client";

import { getQueueTypeColor } from "@/lib/utils";
import type { HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { BsCameraVideo, BsChatText, BsGeoAlt, BsPersonBadge } from "react-icons/bs";
import PersonAvatar from "@/components/ui/person-avatar";
import { useMemo } from "react";
import type { HelpQueueAssignment } from "@/utils/supabase/DatabaseTypes";

/**
 * Get icon for queue type
 */
const getQueueIcon = (type: string) => {
  switch (type) {
    case "video":
      return BsCameraVideo;
    case "in_person":
      return BsGeoAlt;
    default:
      return BsChatText;
  }
};

interface QueueCardProps {
  queue: HelpQueue;
  selected: boolean;
  onClickAction: () => void;
  openRequestCount?: number;
  activeAssignments?: HelpQueueAssignment[];
}

export function QueueCard({
  queue,
  selected,
  onClickAction,
  openRequestCount = 0,
  activeAssignments = []
}: QueueCardProps) {
  const activeStaff = useMemo(() => {
    return activeAssignments.map((assignment) => assignment.ta_profile_id);
  }, [activeAssignments]);

  const queueColor = getQueueTypeColor(queue.queue_type);
  const QueueIcon = getQueueIcon(queue.queue_type);

  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onClickAction}
      onMouseDown={(e) => {
        // Prevent mouse-focus causing scroll jumps in scroll containers.
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClickAction();
        }
      }}
      px="2"
      py="1"
      borderWidth="1px"
      borderColor={selected ? "border.emphasized" : "border.muted"}
      bg={selected ? "bg.muted" : "bg.panel"}
      _hover={{ bg: "bg.subtle" }}
      rounded="md"
      cursor="pointer"
    >
      <HStack gap="3" align="flex-start">
        <Box pt="0.5">
          <Icon as={QueueIcon} color={`${queueColor}.500`} boxSize="5" />
        </Box>
        <Stack spaceY="0" flex="1" minW={0}>
          <HStack justify="space-between" align="flex-start" gap="2">
            <HStack gap="2" align="center">
              <Text fontWeight="semibold" truncate mb={0}>
                {queue.name}
              </Text>
              {queue.is_demo && (
                <Badge colorPalette="orange" variant="solid" fontSize="xs">
                  DEMO - NOT A REAL QUEUE
                </Badge>
              )}
            </HStack>
            <HStack gap="1" align="center">
              {openRequestCount > 0 && (
                <Badge colorPalette="blue" variant="solid">
                  {openRequestCount}
                </Badge>
              )}
            </HStack>
          </HStack>
          {queue.description && (
            <Text fontSize="xs" color="fg.muted" mb={1}>
              {queue.description}
            </Text>
          )}
          <HStack gap="2" align="center" mt={1}>
            <Badge colorPalette={queueColor} variant="subtle" size="sm">
              {queue.queue_type}
            </Badge>
            {activeStaff.length > 0 && (
              <HStack gap="1" align="center">
                <Icon as={BsPersonBadge} fontSize="xs" color="fg.muted" />
                <Text fontSize="xs" color="fg.muted">
                  {activeStaff.length} staff
                </Text>
                <HStack gap="0.5">
                  {activeStaff.slice(0, 3).map((staffId, index) => (
                    <PersonAvatar key={`staff-${staffId}-${index}`} uid={staffId} size="xs" />
                  ))}
                </HStack>
              </HStack>
            )}
          </HStack>
        </Stack>
      </HStack>
    </Box>
  );
}
