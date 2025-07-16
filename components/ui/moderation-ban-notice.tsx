"use client";

import { useModerationStatus, formatTimeRemaining } from "@/hooks/useModerationStatus";
import { Box, VStack, Text, HStack, Icon, Badge, Container, Stack, Separator } from "@chakra-ui/react";
import { BsClock, BsBan, BsExclamationTriangle, BsShield, BsPersonX, BsInfoCircle } from "react-icons/bs";
import { useEffect, useState } from "react";

type ModerationBanNoticeProps = {
  classId: number;
  children?: React.ReactNode;
};

/**
 * Component that checks for active moderation bans and displays appropriate notices.
 * If the user is banned, it prevents access to office hours and shows ban information.
 * If not banned, it renders the children components normally.
 */
export default function ModerationBanNotice({ classId, children }: ModerationBanNoticeProps) {
  const moderationStatus = useModerationStatus(classId);
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);

  // Update time remaining every minute for temporary bans
  useEffect(() => {
    if (moderationStatus.timeRemainingMs && !moderationStatus.isPermanentBan) {
      const updateTimeRemaining = () => {
        const now = new Date().getTime();
        const expiresAt = moderationStatus.banExpiresAt?.getTime() || 0;
        const remaining = expiresAt - now;

        if (remaining <= 0) {
          setTimeRemaining("Expired");
          // Refresh the page to re-check ban status
          window.location.reload();
        } else {
          setTimeRemaining(formatTimeRemaining(remaining));
        }
      };

      // Update immediately
      updateTimeRemaining();

      // Update every minute
      const interval = setInterval(updateTimeRemaining, 60000);

      return () => clearInterval(interval);
    }
  }, [moderationStatus.timeRemainingMs, moderationStatus.banExpiresAt, moderationStatus.isPermanentBan]);

  // Show loading state
  if (moderationStatus.isLoading) {
    return (
      <Container maxW="2xl" py={8}>
        <Box p={6} borderRadius="xl" borderWidth="1px" textAlign="center">
          <VStack gap={3}>
            <Icon as={BsShield} boxSize={6} />
            <Text fontSize="lg" fontWeight="medium">
              Checking moderation status...
            </Text>
          </VStack>
        </Box>
      </Container>
    );
  }

  // Show error state
  if (moderationStatus.error) {
    return (
      <Container maxW="2xl" py={8}>
        <Box p={6} borderRadius="xl" borderWidth="2px" shadow="sm">
          <HStack gap={3}>
            <Icon as={BsExclamationTriangle} boxSize={6} />
            <VStack align="start" gap={1}>
              <Text fontSize="lg" fontWeight="semibold">
                Error checking moderation status
              </Text>
              <Text fontSize="sm">Please refresh the page to try again.</Text>
            </VStack>
          </HStack>
        </Box>
      </Container>
    );
  }

  // If user is banned, show ban notice instead of children
  if (moderationStatus.isBanned) {
    return (
      <Container maxW="3xl" py={8}>
        <Box borderRadius="2xl" borderWidth="2px" shadow="2xl" overflow="hidden">
          {/* Header with gradient background */}
          <Box p={6}>
            <HStack gap={4}>
              <Box p={3} borderRadius="full">
                <Icon as={moderationStatus.isPermanentBan ? BsBan : BsPersonX} boxSize={8} />
              </Box>
              <VStack align="start" gap={1}>
                <Text fontSize="2xl" fontWeight="bold">
                  {moderationStatus.isPermanentBan
                    ? "Permanently Banned from Office Hours"
                    : "Temporarily Banned from Office Hours"}
                </Text>
                <Badge colorPalette="red" size="lg">
                  <HStack gap={1}>
                    <Icon as={BsBan} boxSize={3} />
                    <Text fontWeight="bold">{moderationStatus.isPermanentBan ? "Permanent Ban" : "Temporary Ban"}</Text>
                  </HStack>
                </Badge>
              </VStack>
            </HStack>
          </Box>

          {/* Content */}
          <VStack gap={6} p={6} align="stretch">
            {/* Time remaining for temporary bans */}
            {!moderationStatus.isPermanentBan && timeRemaining && (
              <Box p={4} borderRadius="xl" borderWidth="1px">
                <HStack gap={3}>
                  <Icon as={BsClock} boxSize={5} />
                  <Text fontSize="lg" fontWeight="medium">
                    Time remaining:{" "}
                    <Text as="span" fontWeight="bold">
                      {timeRemaining}
                    </Text>
                  </Text>
                </HStack>
              </Box>
            )}

            {/* Reason section */}
            {moderationStatus.activeBan?.reason && (
              <Box>
                <Text fontSize="lg" fontWeight="semibold" mb={3}>
                  Reason for ban:
                </Text>
                <Box p={4} borderRadius="xl" borderWidth="1px">
                  <Text fontWeight="medium">{moderationStatus.activeBan.reason}</Text>
                </Box>
              </Box>
            )}

            <Separator />

            {/* Restrictions section */}
            <Box>
              <HStack gap={2} mb={4}>
                <Icon as={BsInfoCircle} boxSize={5} />
                <Text fontSize="lg" fontWeight="semibold">
                  Current restrictions:
                </Text>
              </HStack>
              <Stack gap={3}>
                {[
                  "You cannot submit new help requests",
                  "You cannot participate in office hours chat",
                  "You cannot join video meetings",
                  moderationStatus.isPermanentBan
                    ? "This ban does not expire automatically"
                    : "You will regain access when the ban expires"
                ].map((restriction, index) => (
                  <HStack key={index} gap={3} align="start">
                    <Box mt={1.5} w={2} h={2} borderRadius="full" flexShrink={0} />
                    <Text fontSize="sm">{restriction}</Text>
                  </HStack>
                ))}
              </Stack>
            </Box>

            {/* Contact section for permanent bans */}
            {moderationStatus.isPermanentBan && (
              <Box p={5} borderRadius="xl" borderWidth="1px">
                <HStack gap={3} align="start">
                  <Icon as={BsInfoCircle} boxSize={5} mt={0.5} />
                  <VStack align="start" gap={2}>
                    <Text fontSize="sm" fontWeight="semibold">
                      Need to appeal this ban?
                    </Text>
                    <Text fontSize="sm">
                      If you believe this ban was issued in error, please contact your instructor or course staff
                      through alternative means (email, in-person, etc.) to discuss the situation.
                    </Text>
                  </VStack>
                </HStack>
              </Box>
            )}
          </VStack>
        </Box>
      </Container>
    );
  }

  // Show warnings if user has recent warnings but is not banned
  if (moderationStatus.recentWarnings.length > 0) {
    return (
      <VStack gap={6} align="stretch">
        <Container maxW="3xl">
          <Box borderRadius="xl" borderWidth="2px" shadow="lg" overflow="hidden">
            {/* Warning header */}
            <Box p={4}>
              <HStack gap={3}>
                <Box p={2} borderRadius="full">
                  <Icon as={BsExclamationTriangle} boxSize={6} />
                </Box>
                <VStack align="start" gap={1}>
                  <Text fontSize="lg" fontWeight="bold">
                    {moderationStatus.recentWarnings.length} Recent Warning
                    {moderationStatus.recentWarnings.length !== 1 ? "s" : ""}
                  </Text>
                  <Text fontSize="sm" opacity={0.9}>
                    Please be mindful of your behavior in office hours
                  </Text>
                </VStack>
              </HStack>
            </Box>

            {/* Warning content */}
            <VStack gap={4} p={4} align="stretch">
              <Box p={3} borderRadius="lg" borderWidth="1px">
                <Text fontSize="sm" fontWeight="medium">
                  Continued violations may result in temporary or permanent bans from office hours.
                </Text>
              </Box>

              {moderationStatus.recentWarnings.length > 0 && (
                <Box>
                  <Text fontSize="sm" fontWeight="semibold" mb={2}>
                    Most recent warning:
                  </Text>
                  <Box p={3} borderRadius="lg" borderWidth="1px">
                    <Text fontSize="sm">{moderationStatus.recentWarnings[0].reason}</Text>
                  </Box>
                </Box>
              )}
            </VStack>
          </Box>
        </Container>
        {children}
      </VStack>
    );
  }

  // User is not banned and has no recent warnings, render children normally
  return <>{children}</>;
}
