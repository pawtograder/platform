"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import useAuthState from "@/hooks/useAuthState";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useIdentity } from "@/hooks/useIdentities";
import type { NotificationPreferences } from "@/utils/supabase/DatabaseTypes";
import { Box, Fieldset, Heading, NativeSelect, Stack } from "@chakra-ui/react";
import { useCreate, useList, useUpdate } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

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
    NotificationPreferences & { discussion_notification?: "immediate" | "digest" | "disabled" }
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
            discussion_notification: preferences.discussion_notification || "immediate"
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
      };
      setPreferences({
        ...data,
        // Ensure regrade_request_notification has a default if not present
        regrade_request_notification: data.regrade_request_notification || "all",
        // Use initialDiscussionNotification if provided and not yet applied, otherwise use existing or default
        discussion_notification:
          !initialAppliedRef.current && initialDiscussionNotification
            ? initialDiscussionNotification
            : data.discussion_notification || "immediate"
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

  return (
    <Box>
      <Heading size="md" mb={4}>
        Notification Preferences
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
                  <option value="digest">Digest: Receive a summary of discussion activity .</option>
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
