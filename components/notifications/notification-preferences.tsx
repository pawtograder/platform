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

/**
 * Component for managing user notification preferences for help requests.
 * Allows users to choose between immediate, digest, or disabled notifications.
 */
export default function NotificationPreferences() {
  const { course_id } = useParams();
  const { user } = useAuthState();

  const [preferences, setPreferences] = useState<NotificationPreferences>({
    /*
     * The table definition requires these fields, so we provide harmless defaults
     * that will be overwritten as soon as real data is loaded.
     */
    id: 0,
    created_at: new Date().toISOString(),
    user_id: user?.id || "",
    class_id: Number(course_id),
    help_request_creation_notification: "all",
    updated_at: new Date().toISOString()
  });

  const [isLoading, setIsLoading] = useState(false);

  // Fetch existing preferences
  const { data: existingPreferences } = useList<NotificationPreferences>({
    resource: "notification_preferences",
    filters: [
      { field: "user_id", operator: "eq", value: user?.id },
      { field: "class_id", operator: "eq", value: course_id }
    ],
    pagination: { pageSize: 1 }
  });

  const { mutateAsync: createPreferences } = useCreate();
  const { mutateAsync: updatePreferences } = useUpdate();

  // Load existing preferences when data is available
  useEffect(() => {
    if (existingPreferences?.data?.[0]) {
      setPreferences(existingPreferences.data[0]);
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
            updated_at: new Date().toISOString()
          }
        });
      } else {
        // Create new preferences
        await createPreferences({
          resource: "notification_preferences",
          values: {
            user_id: user.id,
            class_id: Number(course_id),
            help_request_creation_notification: preferences.help_request_creation_notification
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
              helperText="Choose how you want to be notified when new help requests are created in your class"
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
          </Stack>
          <Button onClick={handleSave} loading={isLoading}>
            Save Preferences
          </Button>
        </Fieldset.Content>
      </Fieldset.Root>
    </Box>
  );
}
