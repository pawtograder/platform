"use client";

import { RealtimeChat } from "@/components/realtime-chat";
import { useActiveHelpRequest } from "@/hooks/useActiveHelpRequest";
import { useHelpRequestUnreadCount } from "@/hooks/useHelpRequestUnreadCount";
import { useHelpRequestStudents } from "@/hooks/useOfficeHoursRealtime";
import { Badge, Box, Card, Flex, HStack, Icon, IconButton, Stack, Text } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { BsArrowRight, BsChatDots, BsChevronDown, BsChevronUp } from "react-icons/bs";
export function FloatingHelpRequestWidget() {
  const activeRequest = useActiveHelpRequest();
  const router = useRouter();
  const { course_id } = useParams();
  const [isExpanded, setIsExpanded] = useState(false);
  const unreadCount = useHelpRequestUnreadCount(activeRequest?.request.id);
  const allHelpRequestStudents = useHelpRequestStudents();

  // Compute student IDs for the active request
  const helpRequestStudentIds = useMemo(() => {
    if (!activeRequest) return [];
    return allHelpRequestStudents
      .filter((student) => student.help_request_id === activeRequest.request.id)
      .map((student) => student.profile_id);
  }, [activeRequest, allHelpRequestStudents]);

  const handleNavigateToRequest = useCallback(() => {
    if (activeRequest) {
      router.push(`/course/${course_id}/office-hours/${activeRequest.request.help_queue}/${activeRequest.request.id}`);
    }
  }, [activeRequest, course_id, router]);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        if (e.key === " ") {
          e.preventDefault();
        }
        handleToggleExpand();
      }
    },
    [handleToggleExpand]
  );

  if (!activeRequest) {
    return null;
  }

  const statusColor =
    activeRequest.request.status === "in_progress"
      ? "orange"
      : activeRequest.request.status === "open"
        ? "blue"
        : "gray";

  return (
    <Box
      position="fixed"
      bottom={4}
      right={4}
      zIndex={1000}
      maxW={{ base: "calc(100vw - 2rem)", md: "400px" }}
      w="100%"
    >
      <Card.Root>
        <Card.Body p={0}>
          {!isExpanded ? (
            // Minimized state
            <Flex
              align="center"
              gap={3}
              p={4}
              cursor="pointer"
              role="button"
              tabIndex={0}
              onClick={handleToggleExpand}
              onKeyDown={handleKeyDown}
              _hover={{ bg: "bg.subtle" }}
              borderLeftWidth={unreadCount > 0 ? "4px" : "0"}
              borderLeftColor={unreadCount > 0 ? "red.500" : "transparent"}
              bg={unreadCount > 0 ? "red.50" : undefined}
              _dark={{ bg: unreadCount > 0 ? "red.900" : undefined }}
            >
              <Box
                p={2}
                borderRadius="md"
                bg={unreadCount > 0 ? "red.100" : `${statusColor}.50`}
                _dark={{ bg: unreadCount > 0 ? "red.800" : `${statusColor}.900` }}
                position="relative"
              >
                <Icon as={BsChatDots} boxSize={5} color={unreadCount > 0 ? "red.600" : `${statusColor}.600`} />
                {unreadCount > 0 && (
                  <Badge
                    colorPalette="red"
                    variant="solid"
                    position="absolute"
                    top="-1"
                    right="-1"
                    borderRadius="full"
                    minW="5"
                    h="5"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    fontSize="xs"
                    fontWeight="bold"
                    boxShadow="0 0 0 2px white"
                    _dark={{ boxShadow: "0 0 0 2px var(--chakra-colors-gray-800)" }}
                    css={{
                      "@keyframes pulse": {
                        "0%, 100%": { opacity: 1 },
                        "50%": { opacity: 0.5 }
                      },
                      animation: unreadCount > 0 ? "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite" : undefined
                    }}
                  >
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </Badge>
                )}
              </Box>
              <Stack flex="1" minW={0} spaceY={0.5}>
                <Text
                  fontWeight="semibold"
                  fontSize="sm"
                  truncate
                  color={unreadCount > 0 ? "red.700" : undefined}
                  _dark={{ color: unreadCount > 0 ? "red.300" : undefined }}
                >
                  Help Request
                  {unreadCount > 0 && " • New Messages!"}
                </Text>
                <Badge colorPalette={statusColor} variant="solid" size="sm">
                  {activeRequest.request.status === "in_progress"
                    ? "Staff is here helping you now!"
                    : activeRequest.request.status}
                </Badge>
                <Text
                  fontSize="xs"
                  color={unreadCount > 0 ? "red.600" : "fg.muted"}
                  truncate
                  fontWeight={unreadCount > 0 ? "semibold" : "normal"}
                  _dark={{ color: unreadCount > 0 ? "red.400" : undefined }}
                >
                  {unreadCount > 0 ? (
                    <>
                      {unreadCount} unread message{unreadCount !== 1 ? "s" : ""} • Position #
                      {activeRequest.queuePosition}
                    </>
                  ) : (
                    `Position #${activeRequest.queuePosition} in ${activeRequest.queueName}`
                  )}
                </Text>
              </Stack>
              <HStack gap={1}>
                <IconButton
                  aria-label="Go to request"
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNavigateToRequest();
                  }}
                >
                  <Icon as={BsArrowRight} />
                </IconButton>
                <IconButton
                  aria-label="Expand chat"
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleExpand();
                  }}
                >
                  <Icon as={BsChevronUp} />
                </IconButton>
              </HStack>
            </Flex>
          ) : (
            // Expanded state
            <Stack>
              <Flex
                align="center"
                justify="space-between"
                p={3}
                borderBottomWidth="1px"
                borderColor="border.muted"
                bg="bg.subtle"
              >
                <HStack gap={2} flex="1" minW={0}>
                  <Badge colorPalette={statusColor} variant="solid" size="sm">
                    #{activeRequest.queuePosition}
                  </Badge>
                  <Text fontWeight="semibold" fontSize="sm" truncate>
                    {activeRequest.queueName}
                  </Text>
                  <Badge colorPalette={statusColor} variant="subtle" size="sm">
                    {activeRequest.request.status}
                  </Badge>
                </HStack>
                <HStack gap={1}>
                  <IconButton
                    aria-label="Go to full request page"
                    variant="ghost"
                    size="sm"
                    onClick={handleNavigateToRequest}
                  >
                    <Icon as={BsArrowRight} />
                  </IconButton>
                  <IconButton aria-label="Minimize" variant="ghost" size="sm" onClick={handleToggleExpand}>
                    <Icon as={BsChevronDown} />
                  </IconButton>
                </HStack>
              </Flex>
              <Box h={{ base: "60vh", md: "400px" }} maxH="400px" overflow="hidden">
                <RealtimeChat
                  request_id={activeRequest.request.id}
                  helpRequestStudentIds={helpRequestStudentIds}
                  readOnly={false}
                />
              </Box>
            </Stack>
          )}
        </Card.Body>
      </Card.Root>
    </Box>
  );
}
