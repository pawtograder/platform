"use client";

import { Box, Fieldset, Stack, Text, Heading } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@chakra-ui/react";
import { useState, useEffect } from "react";
import { useList, useCreate, useUpdate } from "@refinedev/core";
import { useParams } from "next/navigation";
import useAuthState from "@/hooks/useAuthState";
import { toaster } from "@/components/ui/toaster";
import type { NotificationPreferences } from "@/utils/supabase/DatabaseTypes";

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
    updated_at: null,
    user_id: user?.id || "",
    class_id: Number(course_id),
    help_request_notifications: "digest",
    help_request_message_notifications: "immediate",
    email_digest_frequency: "daily"
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
            help_request_notifications: preferences.help_request_notifications,
            help_request_message_notifications: preferences.help_request_message_notifications,
            email_digest_frequency: preferences.email_digest_frequency,
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
            help_request_notifications: preferences.help_request_notifications,
            help_request_message_notifications: preferences.help_request_message_notifications,
            email_digest_frequency: preferences.email_digest_frequency
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

  return (
    <Box>
      <Heading size="md" mb={4}>
        Notification Preferences
      </Heading>

      <Fieldset.Root>
        <Fieldset.Content>
          <Stack spaceY={6}>
            <Field
              label="Help Request Notifications"
              helperText="Choose how you want to be notified when new help requests are created in your class"
            >
              <NativeSelect.Root>
                <NativeSelect.Field
                  value={preferences.help_request_notifications}
                  onChange={(e) =>
                    setPreferences((prev) => ({
                      ...prev,
                      help_request_notifications: e.target.value as "immediate" | "digest" | "disabled"
                    }))
                  }
                >
                  <option value="immediate">Immediate - Get notified right away</option>
                  <option value="digest">Digest - Get a summary daily/weekly</option>
                  <option value="disabled">Disabled - No notifications</option>
                </NativeSelect.Field>
              </NativeSelect.Root>
            </Field>

            <Field
              label="Help Request Message Notifications"
              helperText="Choose how you want to be notified when new messages are posted to help requests"
            >
              <NativeSelect.Root>
                <NativeSelect.Field
                  value={preferences.help_request_message_notifications}
                  onChange={(e) =>
                    setPreferences((prev) => ({
                      ...prev,
                      help_request_message_notifications: e.target.value as "immediate" | "digest" | "disabled"
                    }))
                  }
                >
                  <option value="immediate">Immediate - Get notified right away</option>
                  <option value="digest">Digest - Get a summary daily/weekly</option>
                  <option value="disabled">Disabled - No notifications</option>
                </NativeSelect.Field>
              </NativeSelect.Root>
            </Field>

            <Field
              label="Email Digest Frequency"
              helperText="How often you want to receive email summaries of help request activity"
            >
              <NativeSelect.Root>
                <NativeSelect.Field
                  value={preferences.email_digest_frequency}
                  onChange={(e) =>
                    setPreferences((prev) => ({
                      ...prev,
                      email_digest_frequency: e.target.value as "daily" | "weekly" | "disabled"
                    }))
                  }
                >
                  <option value="daily">Daily digest</option>
                  <option value="weekly">Weekly digest</option>
                  <option value="disabled">No email digests</option>
                </NativeSelect.Field>
              </NativeSelect.Root>
            </Field>

            <Box pt={4}>
              <Text fontSize="sm" color="fg.muted" mb={4}>
                <strong>Note:</strong> As a student, you will receive digest notifications for new help requests by
                default. TAs and instructors who are actively working on queues will receive immediate notifications for
                all replies in addition to their selected preferences.
              </Text>

              <Button onClick={handleSave} loading={isLoading} colorPalette="blue">
                Save Preferences
              </Button>
            </Box>
          </Stack>
        </Fieldset.Content>
      </Fieldset.Root>
    </Box>
  );
}
