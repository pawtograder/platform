"use client";

import { Box, Button, Field, Heading, HStack, Icon, Input, Stack, Text, VStack, Collapsible } from "@chakra-ui/react";
import { BsDiscord, BsInfoCircle, BsCalendar } from "react-icons/bs";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCourseController } from "@/hooks/useCourseController";
import { useUpdate, useList } from "@refinedev/core";
import { toaster } from "@/components/ui/toaster";
import { useState, useEffect } from "react";
import { useIsGraderOrInstructor, useIsInstructor } from "@/hooks/useClassProfiles";
import { PopoverBody, PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import LinkDiscordAccount from "@/components/discord/link-account";
import PendingInvites from "@/components/discord/pending-invites";
import { SyncRolesPanel } from "@/components/discord/sync-roles-button";
import { createClient } from "@/utils/supabase/client";

/**
 * Admin page for configuring Discord server integration for a class
 * Accessible to instructors and graders, but only instructors can edit settings
 */
export default function DiscordManagementPage() {
  const courseController = useCourseController();
  const course = courseController.course;
  const isStaff = useIsGraderOrInstructor();
  const isInstructor = useIsInstructor();
  const { mutateAsync: updateClass } = useUpdate();

  const [discordServerId, setDiscordServerId] = useState(course?.discord_server_id || "");
  const [discordChannelGroupId, setDiscordChannelGroupId] = useState(course?.discord_channel_group_id || "");
  const [isSaving, setIsSaving] = useState(false);

  // Calendar integration state
  const [officeHoursIcsUrl, setOfficeHoursIcsUrl] = useState(course?.office_hours_ics_url || "");
  const [eventsIcsUrl, setEventsIcsUrl] = useState(course?.events_ics_url || "");
  const [officeHoursEditUrl, setOfficeHoursEditUrl] = useState("");
  const [eventsEditUrl, setEventsEditUrl] = useState("");
  const [isCalendarSaving, setIsCalendarSaving] = useState(false);

  // Fetch staff settings for edit URLs
  const { data: staffSettings } = useList({
    resource: "class_staff_settings",
    filters: [{ field: "class_id", operator: "eq", value: course?.id }],
    queryOptions: { enabled: !!course?.id && isStaff }
  });

  // Update edit URLs when staff settings are loaded
  useEffect(() => {
    if (staffSettings?.data) {
      const settings = staffSettings.data as { setting_key: string; setting_value: string | null }[];
      const ohEditUrl = settings.find((s) => s.setting_key === "office_hours_calendar_edit_url");
      const evEditUrl = settings.find((s) => s.setting_key === "events_calendar_edit_url");
      if (ohEditUrl) setOfficeHoursEditUrl(ohEditUrl.setting_value || "");
      if (evEditUrl) setEventsEditUrl(evEditUrl.setting_value || "");
    }
  }, [staffSettings?.data]);

  // Update ICS URLs when course changes
  useEffect(() => {
    if (course) {
      setOfficeHoursIcsUrl(course.office_hours_ics_url || "");
      setEventsIcsUrl(course.events_ics_url || "");
    }
  }, [course]);

  // Collapse settings if server is already configured
  const isServerConfigured = !!course?.discord_server_id;
  const isCalendarConfigured = !!(course?.office_hours_ics_url || course?.events_ics_url);

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

  const handleCalendarSave = async () => {
    setIsCalendarSaving(true);
    const supabase = createClient();

    try {
      // Save ICS URLs to classes table
      await updateClass({
        resource: "classes",
        id: course.id,
        values: {
          office_hours_ics_url: officeHoursIcsUrl.trim() || null,
          events_ics_url: eventsIcsUrl.trim() || null
        }
      });

      // Save edit URLs to class_staff_settings table (upsert)
      if (officeHoursEditUrl.trim()) {
        await supabase.from("class_staff_settings").upsert(
          {
            class_id: course.id,
            setting_key: "office_hours_calendar_edit_url",
            setting_value: officeHoursEditUrl.trim()
          },
          { onConflict: "class_id,setting_key" }
        );
      } else {
        // Delete if empty
        await supabase
          .from("class_staff_settings")
          .delete()
          .eq("class_id", course.id)
          .eq("setting_key", "office_hours_calendar_edit_url");
      }

      if (eventsEditUrl.trim()) {
        await supabase.from("class_staff_settings").upsert(
          {
            class_id: course.id,
            setting_key: "events_calendar_edit_url",
            setting_value: eventsEditUrl.trim()
          },
          { onConflict: "class_id,setting_key" }
        );
      } else {
        await supabase
          .from("class_staff_settings")
          .delete()
          .eq("class_id", course.id)
          .eq("setting_key", "events_calendar_edit_url");
      }

      toaster.success({
        title: "Calendar settings saved",
        description: "Calendar integration has been configured successfully."
      });
    } catch (error) {
      toaster.error({
        title: "Failed to save",
        description: `Error saving calendar settings: ${error instanceof Error ? error.message : "Unknown error"}`
      });
    } finally {
      setIsCalendarSaving(false);
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

      {/* Pending Invites */}
      <Box>
        <PendingInvites classId={course.id} showAll={true} />
      </Box>

      {/* Sync Roles Panel - Only show if server is configured */}
      {isServerConfigured && (
        <Box>
          <SyncRolesPanel classId={course.id} />
        </Box>
      )}

      {/* Discord Server Configuration */}
      <Box borderWidth="1px" borderRadius="md" p={4}>
        <Collapsible.Root defaultOpen={!isServerConfigured}>
          <Collapsible.Trigger asChild>
            <HStack
              justify="space-between"
              cursor="pointer"
              _hover={{ opacity: 0.8 }}
              transition="opacity 0.2s"
              role="button"
              tabIndex={0}
              mb={isServerConfigured ? 0 : 4}
            >
              <HStack gap={2}>
                <Heading size="md">Server Configuration</Heading>
                {isServerConfigured && (
                  <Text fontSize="sm" color="fg.muted" fontWeight="normal">
                    (Configured)
                  </Text>
                )}
              </HStack>
              <HStack gap={2}>
                <PopoverRoot>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
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
                          <strong>Discord Server ID:</strong> The ID of your Discord server (guild). You can find this
                          by enabling Developer Mode in Discord, right-clicking your server, and selecting &quot;Copy
                          Server ID&quot;.
                        </Text>
                        <Text fontSize="sm">
                          <strong>Channel Group ID:</strong> (Optional) The ID of a Discord category/channel group where
                          class channels will be organized. Leave empty to create channels at the root level.
                        </Text>
                        <Text fontSize="sm">
                          <strong>Note:</strong> The Discord bot must be added to your server with appropriate
                          permissions (Manage Channels, Send Messages, Read Message History).
                        </Text>
                      </VStack>
                    </PopoverBody>
                  </PopoverContent>
                </PopoverRoot>
                <Collapsible.Context>
                  {(collapsible) => (
                    <Icon as={collapsible.open ? ChevronDown : ChevronRight} boxSize={5} color="fg.muted" />
                  )}
                </Collapsible.Context>
              </HStack>
            </HStack>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <VStack align="stretch" gap={4} mt={4}>
              <Field.Root>
                <Field.Label>Discord Server ID</Field.Label>
                <Input
                  value={discordServerId}
                  onChange={(e) => setDiscordServerId(e.target.value)}
                  placeholder="Enter Discord server (guild) ID"
                  readOnly={!isInstructor}
                  disabled={!isInstructor}
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
                  readOnly={!isInstructor}
                  disabled={!isInstructor}
                />
                <Field.HelperText>
                  Right-click a Discord category → Copy ID (requires Developer Mode). Leave empty to create channels at
                  root level.
                </Field.HelperText>
              </Field.Root>

              {isInstructor && (
                <HStack justify="end">
                  <Button onClick={handleSave} colorPalette="blue" loading={isSaving} disabled={isSaving}>
                    Save Configuration
                  </Button>
                </HStack>
              )}
              {!isInstructor && (
                <Text fontSize="sm" color="fg.muted" fontStyle="italic">
                  Only instructors can edit Discord server configuration.
                </Text>
              )}
            </VStack>
          </Collapsible.Content>
        </Collapsible.Root>
      </Box>

      {/* Calendar Integration */}
      <Box borderWidth="1px" borderRadius="md" p={4}>
        <Collapsible.Root defaultOpen={!isCalendarConfigured}>
          <Collapsible.Trigger asChild>
            <HStack
              justify="space-between"
              cursor="pointer"
              _hover={{ opacity: 0.8 }}
              transition="opacity 0.2s"
              role="button"
              tabIndex={0}
              mb={isCalendarConfigured ? 0 : 4}
            >
              <HStack gap={2}>
                <Icon as={BsCalendar} />
                <Heading size="md">Calendar Integration</Heading>
                {isCalendarConfigured && (
                  <Text fontSize="sm" color="fg.muted" fontWeight="normal">
                    (Configured)
                  </Text>
                )}
              </HStack>
              <HStack gap={2}>
                <PopoverRoot>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
                      <Icon as={BsInfoCircle} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent width="lg">
                    <PopoverHeader>
                      <Heading size="sm">Calendar Setup</Heading>
                    </PopoverHeader>
                    <PopoverBody>
                      <VStack align="stretch" gap={2}>
                        <Text fontSize="sm">
                          <strong>ICS URLs:</strong> URLs to ICS calendar files that will be polled every 5 minutes.
                          These are public read URLs (e.g., from Google Calendar, Outlook, etc.).
                        </Text>
                        <Text fontSize="sm">
                          <strong>Edit URLs:</strong> Links to edit the calendars. These are only visible to staff
                          members and appear as edit buttons in the schedule views.
                        </Text>
                        <Text fontSize="sm">
                          <strong>Office Hours Calendar:</strong> For staff schedules. Event titles should be in the
                          format &quot;Name (Queue)&quot; or just &quot;Name&quot;.
                        </Text>
                        <Text fontSize="sm">
                          <strong>Events Calendar:</strong> For staff meetings, etc. Not shown to students.
                        </Text>
                      </VStack>
                    </PopoverBody>
                  </PopoverContent>
                </PopoverRoot>
                <Collapsible.Context>
                  {(collapsible) => (
                    <Icon as={collapsible.open ? ChevronDown : ChevronRight} boxSize={5} color="fg.muted" />
                  )}
                </Collapsible.Context>
              </HStack>
            </HStack>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <VStack align="stretch" gap={4} mt={4}>
              <Field.Root>
                <Field.Label>Office Hours Calendar ICS URL</Field.Label>
                <Input
                  value={officeHoursIcsUrl}
                  onChange={(e) => setOfficeHoursIcsUrl(e.target.value)}
                  placeholder="https://calendar.google.com/calendar/ical/..."
                  readOnly={!isInstructor}
                  disabled={!isInstructor}
                />
                <Field.HelperText>
                  Public ICS feed URL for office hours schedule. Events will be displayed to students.
                </Field.HelperText>
              </Field.Root>

              <Field.Root>
                <Field.Label>Office Hours Calendar Edit URL (Staff Only)</Field.Label>
                <Input
                  value={officeHoursEditUrl}
                  onChange={(e) => setOfficeHoursEditUrl(e.target.value)}
                  placeholder="https://calendar.google.com/calendar/r?cid=..."
                  readOnly={!isInstructor}
                  disabled={!isInstructor}
                />
                <Field.HelperText>Link to edit the calendar. Only visible to staff.</Field.HelperText>
              </Field.Root>

              <Field.Root>
                <Field.Label>Events Calendar ICS URL</Field.Label>
                <Input
                  value={eventsIcsUrl}
                  onChange={(e) => setEventsIcsUrl(e.target.value)}
                  placeholder="https://calendar.google.com/calendar/ical/..."
                  readOnly={!isInstructor}
                  disabled={!isInstructor}
                />
                <Field.HelperText>
                  Public ICS feed URL for staff events (meetings, etc.). Not shown to students.
                </Field.HelperText>
              </Field.Root>

              <Field.Root>
                <Field.Label>Events Calendar Edit URL (Staff Only)</Field.Label>
                <Input
                  value={eventsEditUrl}
                  onChange={(e) => setEventsEditUrl(e.target.value)}
                  placeholder="https://calendar.google.com/calendar/r?cid=..."
                  readOnly={!isInstructor}
                  disabled={!isInstructor}
                />
                <Field.HelperText>Link to edit the events calendar. Only visible to staff.</Field.HelperText>
              </Field.Root>

              {isInstructor && (
                <HStack justify="end">
                  <Button
                    onClick={handleCalendarSave}
                    colorPalette="blue"
                    loading={isCalendarSaving}
                    disabled={isCalendarSaving}
                  >
                    Save Calendar Settings
                  </Button>
                </HStack>
              )}
              {!isInstructor && (
                <Text fontSize="sm" color="fg.muted" fontStyle="italic">
                  Only instructors can edit calendar settings.
                </Text>
              )}
            </VStack>
          </Collapsible.Content>
        </Collapsible.Root>
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
            <li>Announce office hours duty changes to the #scheduling channel</li>
            <li>Announce event start/end to the #operations channel</li>
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
