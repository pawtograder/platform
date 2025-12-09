"use client";

import { Box, Button, Field, Heading, HStack, Icon, Input, Stack, Text, VStack } from "@chakra-ui/react";
import { BsDiscord, BsInfoCircle } from "react-icons/bs";
import { useCourseController } from "@/hooks/useCourseController";
import { useUpdate } from "@refinedev/core";
import { toaster } from "@/components/ui/toaster";
import { useState } from "react";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { PopoverBody, PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import LinkDiscordAccount from "@/components/discord/link-account";

/**
 * Admin page for configuring Discord server integration for a class
 * Only accessible to instructors and graders
 */
export default function DiscordManagementPage() {
  const courseController = useCourseController();
  const course = courseController.course;
  const isStaff = useIsGraderOrInstructor();
  const { mutateAsync: updateClass } = useUpdate();

  const [discordServerId, setDiscordServerId] = useState(course?.discord_server_id || "");
  const [discordChannelGroupId, setDiscordChannelGroupId] = useState(course?.discord_channel_group_id || "");
  const [isSaving, setIsSaving] = useState(false);

  if (!isStaff) {
    return (
      <Box p={4}>
        <Text>You must be an instructor or grader to access this page.</Text>
      </Box>
    );
  }

  if (!course) {
    return (
      <Box p={4}>
        <Text>Loading course information...</Text>
      </Box>
    );
  }

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateClass({
        resource: "classes",
        id: course.id,
        values: {
          discord_server_id: discordServerId.trim() || null,
          discord_channel_group_id: discordChannelGroupId.trim() || null
        }
      });

      toaster.success({
        title: "Discord settings saved",
        description: "Discord server configuration has been updated successfully."
      });
    } catch (error) {
      toaster.error({
        title: "Failed to save",
        description: `Error saving Discord settings: ${error instanceof Error ? error.message : "Unknown error"}`
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <VStack align="stretch" gap={6} w="100%" p={4}>
      <Box>
        <HStack gap={2} mb={2}>
          <Icon as={BsDiscord} size="xl" />
          <Heading size="lg">Discord Integration</Heading>
        </HStack>
        <Text fontSize="sm" color="fg.muted">
          Configure Discord server integration for this class. When enabled, help requests and regrade requests will be
          automatically posted to Discord channels.
        </Text>
      </Box>

      {/* Link Discord Account */}
      <Box>
        <LinkDiscordAccount />
      </Box>

      {/* Discord Server Configuration */}
      <Box borderWidth="1px" borderRadius="md" p={4}>
        <VStack align="stretch" gap={4}>
          <HStack justify="space-between">
            <Heading size="md">Server Configuration</Heading>
            <PopoverRoot>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Icon as={BsInfoCircle} />
                </Button>
              </PopoverTrigger>
              <PopoverContent width="lg">
                <PopoverHeader>
                  <Heading size="sm">Discord Server Setup</Heading>
                </PopoverHeader>
                <PopoverBody>
                  <VStack align="stretch" gap={2}>
                    <Text fontSize="sm">
                      <strong>Discord Server ID:</strong> The ID of your Discord server (guild). You can find this by
                      enabling Developer Mode in Discord, right-clicking your server, and selecting &quot;Copy Server
                      ID&quot;.
                    </Text>
                    <Text fontSize="sm">
                      <strong>Channel Group ID:</strong> (Optional) The ID of a Discord category/channel group where
                      class channels will be organized. Leave empty to create channels at the root level.
                    </Text>
                    <Text fontSize="sm">
                      <strong>Note:</strong> The Discord bot must be added to your server with appropriate permissions
                      (Manage Channels, Send Messages, Read Message History).
                    </Text>
                  </VStack>
                </PopoverBody>
              </PopoverContent>
            </PopoverRoot>
          </HStack>

          <Field.Root>
            <Field.Label>Discord Server ID</Field.Label>
            <Input
              value={discordServerId}
              onChange={(e) => setDiscordServerId(e.target.value)}
              placeholder="Enter Discord server (guild) ID"
            />
            <Field.HelperText>
              Right-click your Discord server → Copy Server ID (requires Developer Mode)
            </Field.HelperText>
          </Field.Root>

          <Field.Root>
            <Field.Label>Channel Group ID (Optional)</Field.Label>
            <Input
              value={discordChannelGroupId}
              onChange={(e) => setDiscordChannelGroupId(e.target.value)}
              placeholder="Enter Discord category/channel group ID"
            />
            <Field.HelperText>
              Right-click a Discord category → Copy ID (requires Developer Mode). Leave empty to create channels at root
              level.
            </Field.HelperText>
          </Field.Root>

          <HStack justify="end">
            <Button onClick={handleSave} colorPalette="blue" loading={isSaving} disabled={isSaving}>
              Save Configuration
            </Button>
          </HStack>
        </VStack>
      </Box>

      {/* Information Box */}
      <Box borderWidth="1px" borderRadius="md" p={4} bg="bg.info">
        <VStack align="stretch" gap={2}>
          <HStack>
            <Icon as={BsInfoCircle} />
            <Heading size="sm">How It Works</Heading>
          </HStack>
          <Text fontSize="sm">Once configured, the Discord bot will automatically:</Text>
          <Stack as="ul" pl={4} fontSize="sm" gap={1}>
            <li>Create channels for assignments, labs, and office hours queues</li>
            <li>Post help requests to the appropriate office hours channel</li>
            <li>Post regrade requests to the #regrades channel</li>
            <li>Update messages when request status changes</li>
            <li>Mention graders and instructors as needed</li>
          </Stack>
          <Text fontSize="sm" mt={2}>
            Staff members can click the Discord icon on help requests and regrade requests to open the Discord message
            in a new tab for side-chat.
          </Text>
        </VStack>
      </Box>
    </VStack>
  );
}
