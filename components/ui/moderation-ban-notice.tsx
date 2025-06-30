"use client";

import { Alert } from "@/components/ui/alert";
import { useModerationStatus, formatTimeRemaining } from "@/hooks/useModerationStatus";
import { Box, VStack, Text, HStack, Icon, Badge } from "@chakra-ui/react";
import { BsClock, BsBan, BsExclamationTriangle } from "react-icons/bs";
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
  console.log(moderationStatus);
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);
  console.log(timeRemaining);

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
      <Box p={4}>
        <Text>Checking moderation status...</Text>
      </Box>
    );
  }

  // Show error state
  if (moderationStatus.error) {
    return (
      <Alert status="error" title="Error checking moderation status">
        Please refresh the page to try again.
      </Alert>
    );
  }

  // If user is banned, show ban notice instead of children
  if (moderationStatus.isBanned) {
    return (
      <Box p={6} maxW="2xl" mx="auto">
        <VStack gap={6} align="stretch">
          <Alert
            status="error"
            title={
              moderationStatus.isPermanentBan
                ? "Permanently Banned from Office Hours"
                : "Temporarily Banned from Office Hours"
            }
          >
            <VStack align="start" gap={3} mt={3}>
              <HStack gap={2}>
                <Icon as={moderationStatus.isPermanentBan ? BsBan : BsClock} />
                <Text fontWeight="medium">{moderationStatus.isPermanentBan ? "Permanent Ban" : "Temporary Ban"}</Text>
                <Badge colorPalette="red" size="sm">
                  Active
                </Badge>
              </HStack>

              {!moderationStatus.isPermanentBan && timeRemaining && (
                <HStack gap={2}>
                  <Icon as={BsClock} />
                  <Text>
                    <Text as="span" fontWeight="medium">
                      Time remaining:
                    </Text>{" "}
                    {timeRemaining}
                  </Text>
                </HStack>
              )}

              {moderationStatus.activeBan?.reason && (
                <Box>
                  <Text fontWeight="medium" mb={1}>
                    Reason:
                  </Text>
                  <Text fontSize="sm" p={3} bg="red.50" borderRadius="md" borderWidth="1px" borderColor="red.200">
                    {moderationStatus.activeBan.reason}
                  </Text>
                </Box>
              )}

              <Box>
                <Text fontWeight="medium" mb={2}>
                  What this means:
                </Text>
                <VStack align="start" fontSize="sm" gap={1}>
                  <Text>• You cannot submit new help requests</Text>
                  <Text>• You cannot participate in office hours chat</Text>
                  <Text>• You cannot join video meetings</Text>
                  {moderationStatus.isPermanentBan ? (
                    <Text>• This ban does not expire automatically</Text>
                  ) : (
                    <Text>• You will regain access when the ban expires</Text>
                  )}
                </VStack>
              </Box>

              {moderationStatus.isPermanentBan && (
                <Box p={3} bg="red.100" borderRadius="md" borderWidth="1px" borderColor="red.300">
                  <Text fontSize="sm">
                    If you believe this ban was issued in error, please contact your instructor or course staff through
                    alternative means (email, in-person, etc.) to discuss the situation.
                  </Text>
                </Box>
              )}
            </VStack>
          </Alert>
        </VStack>
      </Box>
    );
  }

  // Show warnings if user has recent warnings but is not banned
  if (moderationStatus.recentWarnings.length > 0) {
    return (
      <VStack gap={4} align="stretch">
        <Alert
          status="warning"
          title={`You have ${moderationStatus.recentWarnings.length} recent warning${moderationStatus.recentWarnings.length !== 1 ? "s" : ""}`}
        >
          <VStack align="start" gap={2} mt={2}>
            <HStack gap={2}>
              <Icon as={BsExclamationTriangle} />
              <Text fontSize="sm">
                Please be mindful of your behavior in office hours. Continued violations may result in temporary or
                permanent bans.
              </Text>
            </HStack>
            {moderationStatus.recentWarnings.length > 0 && (
              <Box>
                <Text fontWeight="medium" fontSize="sm" mb={1}>
                  Most recent warning:
                </Text>
                <Text fontSize="xs" p={2} bg="yellow.50" borderRadius="md" borderWidth="1px" borderColor="yellow.200">
                  {moderationStatus.recentWarnings[0].reason}
                </Text>
              </Box>
            )}
          </VStack>
        </Alert>
        {children}
      </VStack>
    );
  }

  // User is not banned and has no recent warnings, render children normally
  return <>{children}</>;
}
