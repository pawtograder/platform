"use client";

import { Box, Fieldset, Stack, Heading, Text } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@chakra-ui/react";
import { useState, useEffect } from "react";
import { useList, useCreate, useUpdate } from "@refinedev/core";
import { useParams } from "next/navigation";
import useAuthState from "@/hooks/useAuthState";
import { toaster } from "@/components/ui/toaster";
import type { NotificationPreferences } from "@/utils/supabase/DatabaseTypes";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useIdentity } from "@/hooks/useIdentities";

/**
 * Component for managing user notification preferences for help requests.
 * Allows users to choose between immediate, digest, or disabled notifications.
 */
export default function NotificationPreferencesPanel() {
  const { course_id } = useParams();
  const { user } = useAuthState();
  const { identities } = useIdentity();
  const classId = Number(course_id);
  const discordIdentity = identities?.find((identity) => identity.provider === "discord");
  const hasDiscordLinked = !!discordIdentity;

  const [preferences, setPreferences] = useState<NotificationPreferences>({
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
    updated_at: new Date().toISOString()
  });

  const [isLoading, setIsLoading] = useState(false);

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

  // Load existing preferences when data is available
  useEffect(() => {
    if (existingPreferences?.data?.[0]) {
      setPreferences({
        ...existingPreferences.data[0],
        // Ensure regrade_request_notification has a default if not present
        regrade_request_notification: existingPreferences.data[0].regrade_request_notification || "all"
      });
    }
  }, [existingPreferences]);

  const handleSave = async () => {
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
            regrade_request_notification: preferences.regrade_request_notification
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
  };

  const isInstructorOrGrader = useIsGraderOrInstructor();

  // This will probably be refactored in the future.
  if (!isInstructorOrGrader) {
    return (
      <Box>
        <Text>No specific notification preferences have been implemented for students yet.</Text>
      </Box>
    );
  }

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
              label="Help Request Creation Notifications"
              helperText={`Choose how you want to be notified when new help requests are created in your class. ${discordHelperText}`}
            >
              <NativeSelect.Root>
                <NativeSelect.Field
                  value={preferences.help_request_creation_notification}
                  onChange={(e) =>
                    setPreferences((prev) => ({
                      ...prev,
                      help_request_creation_notification: e.target.value as "all" | "only_active_queue" | "none"
                    }))
                  }
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
                  onChange={(e) =>
                    setPreferences((prev) => ({
                      ...prev,
                      regrade_request_notification: e.target.value as "all" | "only_active_queue" | "none"
                    }))
                  }
                >
                  <option value="all">All: Get notified for all regrade request activity.</option>
                  <option value="none">None: No email notifications for regrade requests.</option>
                </NativeSelect.Field>
              </NativeSelect.Root>
            </Field>
          </Stack>
          <Button onClick={handleSave} loading={isLoading}>
            Save Preferences
          </Button>
        </Fieldset.Content>
      </Fieldset.Root>
    </Box>
  );
}
