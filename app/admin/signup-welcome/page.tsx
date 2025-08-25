"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, Text, Flex, VStack, Heading, HStack } from "@chakra-ui/react";
import { Save, MessageSquare, User, Check } from "lucide-react";
import NotificationForm, { NotificationFormData } from "@/components/notifications/NotificationForm";
import { toaster } from "@/components/ui/toaster";
import { Alert } from "@/components/ui/alert";
import {
  SystemSetting,
  notificationFormToWelcomeMessage,
  welcomeMessageToNotificationForm
} from "@/types/SystemSettings";
import { getSystemSetting, setSystemSetting, deleteSystemSetting } from "@/utils/systemSettings";

export default function SignupWelcomeMessagePage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [currentSetting, setCurrentSetting] = useState<SystemSetting<"signup_welcome_message"> | null>(null);
  const [hasWelcomeMessage, setHasWelcomeMessage] = useState(false);

  // Load current welcome message setting
  useEffect(() => {
    loadCurrentSetting();
  }, []);

  const loadCurrentSetting = async () => {
    setIsLoading(true);
    try {
      const setting = await getSystemSetting("signup_welcome_message");
      setCurrentSetting(setting);
      setHasWelcomeMessage(!!setting);
    } catch (error) {
      toaster.error({
        title: "Failed to load welcome message",
        description: (error as Error).message
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (formData: NotificationFormData) => {
    setIsSubmitting(true);

    try {
      // Convert form data to typed welcome message value
      const welcomeMessageValue = notificationFormToWelcomeMessage(formData);

      // Use typed helper to set the setting
      await setSystemSetting("signup_welcome_message", welcomeMessageValue);

      toaster.success({
        title: "Welcome message saved",
        description: "New users will now receive this welcome message when they sign up."
      });

      // Reload the current setting
      await loadCurrentSetting();
    } catch (error) {
      toaster.error({
        title: "Failed to save welcome message",
        description: (error as Error).message
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDisable = async () => {
    if (!currentSetting) return;

    setIsSubmitting(true);
    try {
      await deleteSystemSetting("signup_welcome_message");

      toaster.success({
        title: "Welcome message disabled",
        description: "New users will no longer receive a welcome message."
      });

      await loadCurrentSetting();
    } catch (error) {
      toaster.error({
        title: "Failed to disable welcome message",
        description: (error as Error).message
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <VStack align="stretch" gap={6}>
        <Heading size="2xl">Signup Welcome Message</Heading>
        <Text>Loading...</Text>
      </VStack>
    );
  }

  // Prepare initial data if we have a current setting
  const initialData: Partial<NotificationFormData> = currentSetting
    ? welcomeMessageToNotificationForm(currentSetting.value)
    : {};

  return (
    <VStack align="stretch" gap={6}>
      {/* Header */}
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">Signup Welcome Message</Heading>
          <Text color="fg.muted">Configure the notification that new users receive when they sign up</Text>
        </VStack>
        <HStack gap={2}>
          <MessageSquare size={16} />
          <Text fontSize="sm" color="fg.muted">
            {hasWelcomeMessage ? "Active" : "Not configured"}
          </Text>
        </HStack>
      </Flex>

      {/* Status Alert */}
      {hasWelcomeMessage ? (
        <Alert status="info">
          <Check size={16} />
          <Text>
            Welcome message is active. New users will receive this notification when they sign up for their first class.
          </Text>
        </Alert>
      ) : (
        <Alert status="warning">
          <User size={16} />
          <Text>No welcome message configured. New users will not receive any welcome notification.</Text>
        </Alert>
      )}

      {/* Form Card */}
      <Card.Root>
        <Card.Header>
          <Card.Title>Welcome Message Configuration</Card.Title>
          <Text color="fg.muted">
            This message will be automatically sent to new users when they get their first role in the system. The
            notification will appear in their notification box.
          </Text>
        </Card.Header>
        <Card.Body>
          <NotificationForm
            initialData={initialData}
            onSubmit={handleSubmit}
            showAudienceTargeting={false}
            isSubmitting={isSubmitting}
          />
        </Card.Body>
        <Card.Footer>
          <HStack gap={3} justify="end" width="100%">
            {hasWelcomeMessage && (
              <Button variant="outline" colorPalette="red" onClick={handleDisable} loading={isSubmitting}>
                Disable Welcome Message
              </Button>
            )}
            <Button type="submit" form="notification-form" loading={isSubmitting} colorPalette="blue">
              <Save size={16} />
              {hasWelcomeMessage ? "Update Welcome Message" : "Create Welcome Message"}
            </Button>
          </HStack>
        </Card.Footer>
      </Card.Root>

      {/* Additional Info */}
      <Card.Root variant="outline">
        <Card.Header>
          <Card.Title fontSize="md">How it Works</Card.Title>
        </Card.Header>
        <Card.Body>
          <VStack align="start" gap={3}>
            <Text fontSize="sm" color="fg.muted">
              • The welcome message is automatically sent when a user gets their first role (student, instructor, or
              admin)
            </Text>
            <Text fontSize="sm" color="fg.muted">
              • Users will see the notification in their notification box on their next login
            </Text>
            <Text fontSize="sm" color="fg.muted">
              • The message supports Markdown formatting for rich text content
            </Text>
            <Text fontSize="sm" color="fg.muted">
              • You can configure display mode, severity, and other notification properties
            </Text>
          </VStack>
        </Card.Body>
      </Card.Root>
    </VStack>
  );
}
