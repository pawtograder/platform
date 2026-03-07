"use client";

import { getNotificationManager } from "@/lib/notifications";
import { Alert, Box, Button, CloseButton, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";
import { BsBell, BsBellSlash, BsExclamationTriangle } from "react-icons/bs";

export interface NotificationPermissionWarningProps {
  /**
   * Type of user viewing this warning - changes the copy
   */
  userType: "student" | "staff";
  /**
   * Optional custom message to display
   */
  customMessage?: string;
  /**
   * Whether to show the warning in a compact form
   */
  compact?: boolean;
  /**
   * Callback when the warning is dismissed
   */
  onDismiss?: () => void;
  /**
   * Callback when permission is granted
   */
  onPermissionGranted?: () => void;
}

/**
 * Warning banner that displays when browser notification permission is not granted.
 * Prompts users to enable notifications so they don't miss important messages.
 */
export default function NotificationPermissionWarning({
  userType,
  customMessage,
  compact = false,
  onDismiss,
  onPermissionGranted
}: NotificationPermissionWarningProps) {
  const [permissionState, setPermissionState] = useState<NotificationPermission | "unsupported">("default");
  const [isDismissed, setIsDismissed] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);

  // Check initial permission state and dismissal status
  useEffect(() => {
    if (typeof window === "undefined") return;

    const manager = getNotificationManager();
    setPermissionState(manager.getPermissionState());
    setIsDismissed(manager.isWarningDismissed());

    // Also check if browser notifications are enabled in preferences
    const prefs = manager.getPreferences();
    if (!prefs.browserEnabled) {
      // If user has disabled browser notifications in settings, don't show warning
      setIsDismissed(true);
    }
  }, []);

  const handleRequestPermission = useCallback(async () => {
    setIsRequesting(true);
    try {
      const manager = getNotificationManager();
      const permission = await manager.requestPermission();
      setPermissionState(permission);

      if (permission === "granted") {
        onPermissionGranted?.();
      }
    } finally {
      setIsRequesting(false);
    }
  }, [onPermissionGranted]);

  const handleDismiss = useCallback(() => {
    const manager = getNotificationManager();
    manager.dismissWarning();
    setIsDismissed(true);
    onDismiss?.();
  }, [onDismiss]);

  // Don't show if permission is already granted, unsupported, or dismissed
  if (permissionState === "granted" || permissionState === "unsupported" || isDismissed) {
    return null;
  }

  // Message based on user type
  const getMessage = () => {
    if (customMessage) return customMessage;

    if (userType === "student") {
      return "Enable notifications to know when staff responds to your help request - otherwise you might miss their message!";
    }
    return "Enable notifications to be alerted when students message you - otherwise you might miss their questions!";
  };

  const getTitle = () => {
    if (permissionState === "denied") {
      return "Notifications are blocked";
    }
    return "Don't miss important messages!";
  };

  // Compact version for inline display
  if (compact) {
    return (
      <Box p={2} bg="orange.subtle" borderRadius="md" borderWidth="1px" borderColor="orange.emphasized" fontSize="sm">
        <HStack justify="space-between" align="center" gap={2}>
          <HStack gap={2} flex={1}>
            <Icon as={BsExclamationTriangle} color="orange.fg" />
            <Text color="orange.fg" fontSize="xs">
              {permissionState === "denied"
                ? "Notifications blocked - enable in browser settings"
                : "Enable notifications to avoid missing messages"}
            </Text>
          </HStack>
          {permissionState !== "denied" && (
            <Button
              size="xs"
              colorPalette="orange"
              variant="solid"
              onClick={handleRequestPermission}
              loading={isRequesting}
            >
              Enable
            </Button>
          )}
          <CloseButton size="sm" onClick={handleDismiss} aria-label="Dismiss warning" />
        </HStack>
      </Box>
    );
  }

  // Full banner version
  return (
    <Alert.Root status="warning" variant="subtle" borderRadius="md" mb={4}>
      <Alert.Indicator>
        <Icon as={permissionState === "denied" ? BsBellSlash : BsBell} />
      </Alert.Indicator>
      <VStack align="start" flex={1} gap={2}>
        <Alert.Title fontWeight="semibold">{getTitle()}</Alert.Title>
        <Alert.Description fontSize="sm">{getMessage()}</Alert.Description>
        <HStack gap={2} mt={1}>
          {permissionState === "denied" ? (
            <Text fontSize="xs" color="fg.muted">
              To enable notifications, click the lock icon in your browser&apos;s address bar and allow notifications
              for this site.
            </Text>
          ) : (
            <Button size="sm" colorPalette="orange" onClick={handleRequestPermission} loading={isRequesting}>
              <Icon as={BsBell} mr={1} />
              Enable Notifications
            </Button>
          )}
        </HStack>
      </VStack>
      <CloseButton position="absolute" right={2} top={2} onClick={handleDismiss} aria-label="Dismiss warning" />
    </Alert.Root>
  );
}

/**
 * Hook to check if the notification permission warning should be shown
 */
export function useShowNotificationWarning(): boolean {
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const manager = getNotificationManager();
    const permissionState = manager.getPermissionState();
    const isDismissed = manager.isWarningDismissed();
    const prefs = manager.getPreferences();

    // Show warning if:
    // 1. Permission is not granted
    // 2. Warning hasn't been dismissed
    // 3. User has browser notifications enabled in preferences
    setShouldShow(
      permissionState !== "granted" && permissionState !== "unsupported" && !isDismissed && prefs.browserEnabled
    );
  }, []);

  return shouldShow;
}
