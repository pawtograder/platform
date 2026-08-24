"use client";

import {
  Box,
  Button,
  Field,
  Heading,
  HStack,
  Icon,
  Input,
  Stack,
  Text,
  VisuallyHidden,
  VStack,
  Collapsible
} from "@chakra-ui/react";
import { BsDiscord, BsInfoCircle, BsCalendar } from "react-icons/bs";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCourseController } from "@/hooks/useCourseController";
import { useUpdate } from "@refinedev/core";
import { toaster } from "@/components/ui/toaster";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useIsGraderOrInstructor, useIsInstructor } from "@/hooks/useClassProfiles";
import { PopoverBody, PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import { Alert } from "@/components/ui/alert";
import LinkDiscordAccount from "@/components/discord/link-account";
import DiscordInstallationStatus from "@/components/discord/installation-status";
import DiscordMembershipStatusAlerts from "@/components/discord/membership-status-alerts";
import PendingInvites from "@/components/discord/pending-invites";
import { SyncRolesPanel } from "@/components/discord/sync-roles-button";

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
  // The install callback (app/api/discord/install/callback) lands back here with either
  // `discord_installed` or the `error_description` the rest of the app already uses for redirected
  // failures, so the outcome of a trip through Discord is reported on the page that started it.
  const searchParams = useSearchParams();
  const installOutcome = searchParams.get("discord_installed");
  // `discord_error_description`, not the bare `error_description`: LinkDiscordAccount below reads that
  // one and titles it "Discord Connection Error", so a failed *install* used to raise a second, false
  // alert about the instructor's own Discord account. See manageDiscordPageUrl.
  const installError = searchParams.get("discord_error_description");
  // Which operation failed. Both the install callback and the disconnect route redirect here with a
  // description, and a single fixed title reported a failed disconnect as "The Discord server was not
  // connected" -- the opposite of what happened, on the page whose job is to say what the state is.
  const installErrorKind = searchParams.get("discord_error");
  // "noop" when there was nothing connected, so a double-submitted disconnect stays quiet rather
  // than announcing a teardown that did not happen.
  const disconnectOutcome = searchParams.get("discord_disconnected");

  const [discordChannelGroupId, setDiscordChannelGroupId] = useState(course?.discord_channel_group_id || "");
  const [isSaving, setIsSaving] = useState(false);

  // Calendar integration state
  const [officeHoursIcsUrl, setOfficeHoursIcsUrl] = useState(course?.office_hours_ics_url || "");
  const [eventsIcsUrl, setEventsIcsUrl] = useState(course?.events_ics_url || "");
  const [isCalendarSaving, setIsCalendarSaving] = useState(false);

  // Re-seed each field from the course only when THAT field's stored value changes, not on every new
  // `course` object.
  //
  // useCourseController applies realtime updates with `setCourse(c => ({ ...c, ...updated }))`, so any
  // UPDATE to the classes row -- including claim_discord_guild() stamping discord_server_claimed_at,
  // and including this page's own save -- produces a fresh object identity. Depending on `course`
  // therefore re-ran on writes that touched none of these columns and overwrote whatever the
  // instructor had typed, mid-edit, with the stored value. Depending on the primitive columns means
  // the effect fires only when the stored value genuinely differs, which is the case it exists for
  // (another tab, another instructor) and the only case where discarding local input is correct.
  useEffect(() => {
    setOfficeHoursIcsUrl(course?.office_hours_ics_url || "");
  }, [course?.office_hours_ics_url]);
  useEffect(() => {
    setEventsIcsUrl(course?.events_ics_url || "");
  }, [course?.events_ics_url]);
  useEffect(() => {
    setDiscordChannelGroupId(course?.discord_channel_group_id || "");
  }, [course?.discord_channel_group_id]);

  // Whether a server is *named*. Whether the bot is actually in it, and can work there, is what
  // DiscordInstallationStatus answers -- the two are not the same thing, which is the whole reason
  // that panel exists.
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
      // discord_server_id is deliberately absent. It is no longer writable through an instructor
      // UPDATE: only_calendar_or_discord_ids_changed() dropped it from its allow-list when the guild
      // claim flow landed, and claim_discord_guild() is now its only writer. Sending it here would
      // fail the RLS check and take the channel group down with it.
      await updateClass({
        resource: "classes",
        id: course.id,
        values: {
          discord_channel_group_id: discordChannelGroupId.trim() || null
        }
      });

      toaster.success({
        title: "Discord settings saved",
        description: "The channel category has been updated."
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

      {/* The outcome of a trip through Discord's consent screen. Rendered before the panel below so
          a failure is the first thing on the page, and titled in words rather than signalled only by
          the alert's colour. */}
      {installError && (
        <Alert
          status="error"
          title={
            installErrorKind === "discord_disconnect_failed"
              ? "The Discord server was not disconnected"
              : "The Discord server was not connected"
          }
        >
          <Text>{installError}</Text>
        </Alert>
      )}
      {installOutcome && !installError && (
        <Alert
          status="success"
          title={
            installOutcome === "moved"
              ? "This course was moved to a different Discord server"
              : "Discord server connected"
          }
        >
          <Text>
            {installOutcome === "moved"
              ? "The roles, channels and tracked messages from the previous server have been dropped, and Pawtograder is creating them again in the new one. This takes a minute."
              : "Pawtograder is creating this course's roles and channels in the server now. This takes a minute."}
          </Text>
        </Alert>
      )}

      {disconnectOutcome === "1" && !installError && (
        <Alert status="success" title="Discord server disconnected">
          <Text>
            This course no longer has a Discord server. Pawtograder has forgotten the roles and channels it created
            there; those still exist in Discord and can be deleted by a server administrator. Nobody was removed from
            the server.
          </Text>
        </Alert>
      )}

      {/* Whether the bot is in the server, and whether it can work there */}
      <DiscordInstallationStatus classId={course.id} canManage={isInstructor} />

      {/* Students who are not in the server, and whether that needs an admin */}
      {isServerConfigured && <DiscordMembershipStatusAlerts classId={course.id} alwaysOfferRetry />}

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

      {/* Channel organization. The server itself is claimed through the install flow above -- there is
          no server-id field any more, because typing one authorized nothing. This category id names a
          container *inside* a server the course already controls, so it stays a plain editable
          field. */}
      <Box borderWidth="1px" borderRadius="md" p={4}>
        <Collapsible.Root defaultOpen={isServerConfigured && !course.discord_channel_group_id}>
          <Collapsible.Trigger asChild>
            <HStack
              justify="space-between"
              cursor="pointer"
              _hover={{ opacity: 0.8 }}
              transition="opacity 0.2s"
              role="button"
              tabIndex={0}
            >
              <HStack gap={2}>
                <Heading size="md">Channel Organization</Heading>
                {course.discord_channel_group_id && (
                  <Text fontSize="sm" color="fg.muted" fontWeight="normal">
                    (Category set)
                  </Text>
                )}
              </HStack>
              <HStack gap={2}>
                <PopoverRoot>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
                      <Icon as={BsInfoCircle} />
                      <VisuallyHidden>About channel organization</VisuallyHidden>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent width="lg">
                    <PopoverHeader>
                      <Heading size="sm">Channel Organization</Heading>
                    </PopoverHeader>
                    <PopoverBody>
                      <VStack align="stretch" gap={2}>
                        <Text fontSize="sm">
                          <strong>Channel Category ID:</strong> (Optional) The ID of a Discord category the
                          course&apos;s channels will be created under. Leave empty to create them at the root of the
                          server.
                        </Text>
                        <Text fontSize="sm">
                          Enable Developer Mode in Discord (Settings → Advanced), then right-click the category → Copy
                          ID.
                        </Text>
                        <Text fontSize="sm">
                          <strong>Note:</strong> this is cleared automatically if the course is moved to a different
                          Discord server, since the id belongs to the server it came from.
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
                <Field.Label>Channel Category ID (Optional)</Field.Label>
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
                    (Configured, will auto-sync every 5 minutes)
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
            {/* The office-hours duty and event start/end announcements were removed, not moved: they
                were disabled by 20260109111546_disable_calendar_discord_notifications.sql, and
                supabase/functions/calendar-sync/index.ts still marks that path "Currently unused".
                Promising them here was the only place the product still claimed they happen. */}
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
