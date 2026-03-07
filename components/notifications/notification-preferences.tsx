"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import useAuthState from "@/hooks/useAuthState";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useIdentity } from "@/hooks/useIdentities";
import { getNotificationManager, type ChatNotificationPreferences } from "@/lib/notifications";
import type { NotificationPreferences } from "@/utils/supabase/DatabaseTypes";
import { Box, Fieldset, Heading, HStack, NativeSelect, Slider, Stack, Switch, Text } from "@chakra-ui/react";
import { useCreate, useList, useUpdate } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { BsBell, BsVolumeUp } from "react-icons/bs";

/**
 * Component for managing user notification preferences.
 * Allows users to choose between immediate, digest, or disabled notifications for various features.
 */
export default function NotificationPreferencesPanel({
  initialDiscussionNotification
}: {
  initialDiscussionNotification?: "immediate" | "digest" | "disabled" | null;
}) {
  const { course_id } = useParams();
  const { user } = useAuthState();
  const { identities } = useIdentity();
  const classId = Number(course_id);
  const discordIdentity = identities?.find((identity) => identity.provider === "discord");
  const hasDiscordLinked = !!discordIdentity;

  const [preferences, setPreferences] = useState<
    NotificationPreferences & {
      discussion_notification?: "immediate" | "digest" | "disabled";
      discussion_discord_notification?: "all" | "followed_only" | "none";
    }
  >({
    /*
     * The table definition requires these fields, so we provide harmless defaults
     * that will be overwritten as soon as real data is loaded.
     */
    id: 0,
    created_at: new Date().toISOString(),
    user_id: user?.id || "",
    class_id: classId,
    help_request_creation_notification: "all",
    regrade_request_notification: "all",
    discussion_notification: "immediate",
    discussion_discord_notification: "all",
    updated_at: new Date().toISOString()
  });

  const [isLoading, setIsLoading] = useState(false);
  const hasAutoSaved = useRef(false);
  const initialAppliedRef = useRef(false);
  const isDirtyRef = useRef(false);

  // Fetch existing preferences
  const { data: existingPreferences } = useList<NotificationPreferences>({
    resource: "notification_preferences",
    filters: [
      { field: "user_id", operator: "eq", value: user?.id },
      { field: "class_id", operator: "eq", value: classId }
    ],
    pagination: { pageSize: 1 },
    queryOptions: {
      enabled: Boolean(user?.id) && Number.isFinite(classId)
    }
  });

  const { mutateAsync: createPreferences } = useCreate();
  const { mutateAsync: updatePreferences } = useUpdate();

  const handleSave = useCallback(async () => {
    if (!user?.id) {
      toaster.error({
        title: "Error",
        description: "You must be logged in to save preferences"
      });
      return;
    }

    setIsLoading(true);

    try {
      if (preferences.id) {
        // Update existing preferences
        await updatePreferences({
          resource: "notification_preferences",
          id: preferences.id,
          values: {
            help_request_creation_notification: preferences.help_request_creation_notification,
            regrade_request_notification: preferences.regrade_request_notification,
            discussion_notification: preferences.discussion_notification || "immediate",
            discussion_discord_notification: preferences.discussion_discord_notification || "all",
            updated_at: new Date().toISOString()
          }
        });
      } else {
        // Create new preferences
        await createPreferences({
          resource: "notification_preferences",
          values: {
            user_id: user.id,
            class_id: classId,
            help_request_creation_notification: preferences.help_request_creation_notification,
            regrade_request_notification: preferences.regrade_request_notification,
            discussion_notification: preferences.discussion_notification || "immediate",
            discussion_discord_notification: preferences.discussion_discord_notification || "all"
          }
        });
      }

      toaster.success({
        title: "Success",
        description: "Notification preferences saved successfully"
      });
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to save preferences: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setIsLoading(false);
    }
  }, [user?.id, preferences, classId, updatePreferences, createPreferences]);

  // Load existing preferences when data is available
  useEffect(() => {
    // Skip applying initial values if user has made edits
    if (isDirtyRef.current) {
      return;
    }

    if (existingPreferences?.data?.[0]) {
      const data = existingPreferences.data[0] as NotificationPreferences & {
        discussion_notification?: "immediate" | "digest" | "disabled";
        discussion_discord_notification?: "all" | "followed_only" | "none";
      };
      setPreferences({
        ...data,
        // Ensure regrade_request_notification has a default if not present
        regrade_request_notification: data.regrade_request_notification || "all",
        // Use initialDiscussionNotification if provided and not yet applied, otherwise use existing or default
        discussion_notification:
          !initialAppliedRef.current && initialDiscussionNotification
            ? initialDiscussionNotification
            : data.discussion_notification || "immediate",
        // Ensure discussion_discord_notification has a default
        discussion_discord_notification: data.discussion_discord_notification || "all"
      });
      // Mark initial values as applied after first load
      if (!initialAppliedRef.current && initialDiscussionNotification) {
        initialAppliedRef.current = true;
      }
    } else if (initialDiscussionNotification && !initialAppliedRef.current) {
      // If no existing preferences but we have an initial value, set it
      setPreferences((prev) => ({
        ...prev,
        discussion_notification: initialDiscussionNotification
      }));
      initialAppliedRef.current = true;
    }
  }, [existingPreferences, initialDiscussionNotification]);

  // Auto-save if initialDiscussionNotification is provided via deep link
  useEffect(() => {
    if (
      initialDiscussionNotification &&
      user?.id &&
      !hasAutoSaved.current &&
      existingPreferences?.data !== undefined &&
      preferences.discussion_notification === initialDiscussionNotification
    ) {
      const existingPref = existingPreferences?.data?.[0] as NotificationPreferences & {
        discussion_notification?: string;
      };
      // Only auto-save if the value is different from existing or if no preferences exist
      if (!existingPref || existingPref.discussion_notification !== initialDiscussionNotification) {
        hasAutoSaved.current = true;
        handleSave();
      }
    }
  }, [
    initialDiscussionNotification,
    user?.id,
    existingPreferences?.data,
    preferences.discussion_notification,
    handleSave
  ]);

  const isInstructorOrGrader = useIsGraderOrInstructor();

  const discordHelperText = hasDiscordLinked
    ? "You have Discord linked. Default is NO email notifications (you'll receive Discord notifications instead)."
    : "If you link Discord, the default will be NO email notifications.";

  // Chat notification preferences (localStorage-based)
  const [chatPrefs, setChatPrefs] = useState<ChatNotificationPreferences>(() => {
    if (typeof window !== "undefined") {
      return getNotificationManager().getPreferences();
    }
    return {
      soundEnabled: true,
      browserEnabled: true,
      titleFlashEnabled: true,
      faviconBadgeEnabled: true,
      volume: 0.5
    };
  });

  const [browserPermission, setBrowserPermission] = useState<NotificationPermission | "unsupported">("default");

  // Load browser permission state
  useEffect(() => {
    if (typeof window !== "undefined") {
      setBrowserPermission(getNotificationManager().getPermissionState());
    }
  }, []);

  const handleChatPrefChange = useCallback((key: keyof ChatNotificationPreferences, value: boolean | number) => {
    setChatPrefs((prev) => {
      const updated = { ...prev, [key]: value };
      getNotificationManager().setPreferences(updated);
      return updated;
    });
  }, []);

  const handleRequestBrowserPermission = useCallback(async () => {
    const permission = await getNotificationManager().requestPermission();
    setBrowserPermission(permission);
    if (permission === "granted") {
      toaster.success({
        title: "Notifications enabled",
        description: "You will now receive browser notifications for new messages."
      });
    } else if (permission === "denied") {
      toaster.error({
        title: "Notifications blocked",
        description: "Please enable notifications in your browser settings to receive alerts."
      });
    }
  }, []);

  const handleTestNotification = useCallback(() => {
    getNotificationManager().testNotification();
    toaster.info({
      title: "Test notification sent",
      description: "Check your browser for the notification."
    });
  }, []);

  return (
    <Box>
      {/* Office Hours Chat Notifications Section */}
      <Heading size="md" mb={4}>
        Office Hours Chat Notifications
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={4}>
        These settings control how you&apos;re alerted when you receive new messages in office hours chats. All
        notifications are enabled by default.
      </Text>
      <Fieldset.Root mb={8}>
        <Fieldset.Content>
          <Stack spaceY={4}>
            {/* Browser Notifications */}
            <Box p={4} borderWidth="1px" borderRadius="md" borderColor="border.subtle">
              <HStack justify="space-between" align="start" mb={2}>
                <Box flex={1}>
                  <HStack mb={1}>
                    <BsBell />
                    <Text fontWeight="medium">Browser Notifications</Text>
                  </HStack>
                  <Text fontSize="sm" color="fg.muted">
                    Show desktop notifications even when you&apos;re in a different tab or window.
                  </Text>
                </Box>
                <Switch.Root
                  checked={chatPrefs.browserEnabled}
                  onCheckedChange={(e) => handleChatPrefChange("browserEnabled", e.checked)}
                  disabled={browserPermission === "denied"}
                >
                  <Switch.HiddenInput />
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Root>
              </HStack>
              {browserPermission === "default" && chatPrefs.browserEnabled && (
                <Button size="sm" colorPalette="blue" variant="outline" onClick={handleRequestBrowserPermission} mt={2}>
                  Enable Browser Notifications
                </Button>
              )}
              {browserPermission === "denied" && (
                <Text fontSize="sm" color="fg.error" mt={2}>
                  Browser notifications are blocked. Please enable them in your browser settings.
                </Text>
              )}
              {browserPermission === "granted" && chatPrefs.browserEnabled && (
                <Text fontSize="sm" color="fg.success" mt={2}>
                  Browser notifications are enabled.
                </Text>
              )}
            </Box>

            {/* Sound Notifications */}
            <Box p={4} borderWidth="1px" borderRadius="md" borderColor="border.subtle">
              <HStack justify="space-between" align="start" mb={2}>
                <Box flex={1}>
                  <HStack mb={1}>
                    <BsVolumeUp />
                    <Text fontWeight="medium">Sound Notifications</Text>
                  </HStack>
                  <Text fontSize="sm" color="fg.muted">
                    Play a sound when you receive a new message.
                  </Text>
                </Box>
                <Switch.Root
                  checked={chatPrefs.soundEnabled}
                  onCheckedChange={(e) => handleChatPrefChange("soundEnabled", e.checked)}
                >
                  <Switch.HiddenInput />
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Root>
              </HStack>
              {chatPrefs.soundEnabled && (
                <Box mt={3}>
                  <Text fontSize="sm" mb={2}>
                    Volume: {Math.round(chatPrefs.volume * 100)}%
                  </Text>
                  <Slider.Root
                    value={[chatPrefs.volume * 100]}
                    onValueChange={(e) => handleChatPrefChange("volume", e.value[0] / 100)}
                    min={0}
                    max={100}
                    step={10}
                    width="200px"
                  >
                    <Slider.Control>
                      <Slider.Track>
                        <Slider.Range />
                      </Slider.Track>
                      <Slider.Thumb index={0} />
                    </Slider.Control>
                  </Slider.Root>
                </Box>
              )}
            </Box>

            {/* Title Flash */}
            <Box p={4} borderWidth="1px" borderRadius="md" borderColor="border.subtle">
              <HStack justify="space-between" align="center">
                <Box flex={1}>
                  <Text fontWeight="medium" mb={1}>
                    Title Flashing
                  </Text>
                  <Text fontSize="sm" color="fg.muted">
                    Flash the browser tab title when you have unread messages.
                  </Text>
                </Box>
                <Switch.Root
                  checked={chatPrefs.titleFlashEnabled}
                  onCheckedChange={(e) => handleChatPrefChange("titleFlashEnabled", e.checked)}
                >
                  <Switch.HiddenInput />
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Root>
              </HStack>
            </Box>

            {/* Favicon Badge */}
            <Box p={4} borderWidth="1px" borderRadius="md" borderColor="border.subtle">
              <HStack justify="space-between" align="center">
                <Box flex={1}>
                  <Text fontWeight="medium" mb={1}>
                    Favicon Badge
                  </Text>
                  <Text fontSize="sm" color="fg.muted">
                    Show an unread count badge on the browser tab icon.
                  </Text>
                </Box>
                <Switch.Root
                  checked={chatPrefs.faviconBadgeEnabled}
                  onCheckedChange={(e) => handleChatPrefChange("faviconBadgeEnabled", e.checked)}
                >
                  <Switch.HiddenInput />
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Root>
              </HStack>
            </Box>

            {/* Test Button */}
            <Button size="sm" variant="outline" onClick={handleTestNotification}>
              Test Notification
            </Button>
          </Stack>
        </Fieldset.Content>
      </Fieldset.Root>

      {/* Email Notification Preferences Section */}
      <Heading size="md" mb={4}>
        Email Notification Preferences
      </Heading>
      <Fieldset.Root>
        <Fieldset.Content>
          <Stack spaceY={6}>
            <Field
              label="Discussion Board Notifications"
              helperText="Choose how you want to receive email notifications for discussion board activity. Following a topic notifies you of new posts only. Following a post notifies you of all replies to that post."
            >
              <NativeSelect.Root>
                <NativeSelect.Field
                  value={preferences.discussion_notification || "immediate"}
                  onChange={(e) => {
                    isDirtyRef.current = true;
                    setPreferences((prev) => ({
                      ...prev,
                      discussion_notification: e.target.value as "immediate" | "digest" | "disabled"
                    }));
                  }}
                >
                  <option value="immediate">Immediate: Receive emails as soon as new posts or replies are made.</option>
                  <option value="digest">Digest: Receive a summary of discussion activity.</option>
                  <option value="disabled">Disabled: No email notifications for discussion board activity.</option>
                </NativeSelect.Field>
              </NativeSelect.Root>
            </Field>
            {isInstructorOrGrader && (
              <>
                <Field
                  label="Help Request Creation Notifications"
                  helperText={`Choose how you want to be notified when new help requests are created in your class. ${discordHelperText}`}
                >
                  <NativeSelect.Root>
                    <NativeSelect.Field
                      value={preferences.help_request_creation_notification}
                      onChange={(e) => {
                        isDirtyRef.current = true;
                        setPreferences((prev) => ({
                          ...prev,
                          help_request_creation_notification: e.target.value as "all" | "only_active_queue" | "none"
                        }));
                      }}
                    >
                      <option value="all">All: Get notified for all help request creations.</option>
                      <option value="only_active_queue">
                        Only active queue: Get notified for help requests in your active queue.
                      </option>
                      <option value="none">None: No notifications for help request creations.</option>
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                </Field>
                <Field
                  label="Regrade Request Notifications"
                  helperText={`Choose how you want to be notified about regrade requests. ${discordHelperText}`}
                >
                  <NativeSelect.Root>
                    <NativeSelect.Field
                      value={preferences.regrade_request_notification || "all"}
                      onChange={(e) => {
                        isDirtyRef.current = true;
                        setPreferences((prev) => ({
                          ...prev,
                          regrade_request_notification: e.target.value as "all" | "none"
                        }));
                      }}
                    >
                      <option value="all">All: Get notified for all regrade request activity.</option>
                      <option value="none">None: No email notifications for regrade requests.</option>
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                </Field>
                {hasDiscordLinked && (
                  <Field
                    label="Discussion Discord Notifications"
                    helperText="Control Discord notifications for new discussion threads posted to Discord-linked topics."
                  >
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        value={preferences.discussion_discord_notification || "all"}
                        onChange={(e) => {
                          isDirtyRef.current = true;
                          setPreferences((prev) => ({
                            ...prev,
                            discussion_discord_notification: e.target.value as "all" | "followed_only" | "none"
                          }));
                        }}
                      >
                        <option value="all">All: See Discord messages for all new discussion threads.</option>
                        <option value="followed_only">
                          Followed only: Only see Discord messages for topics you follow.
                        </option>
                        <option value="none">None: Don&apos;t show me Discord notifications for discussions.</option>
                      </NativeSelect.Field>
                    </NativeSelect.Root>
                  </Field>
                )}
              </>
            )}
          </Stack>
          <Button onClick={handleSave} loading={isLoading} colorPalette="green">
            Save Preferences
          </Button>
        </Fieldset.Content>
      </Fieldset.Root>
    </Box>
  );
}
