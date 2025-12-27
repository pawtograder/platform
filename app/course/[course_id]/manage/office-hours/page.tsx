"use client";

import { Box, Tabs } from "@chakra-ui/react";
import HelpQueuesDashboard from "./helpQueuesDashboard";
import HelpQueueManagement from "./helpQueueManagement";
import HelpQueueAssignmentManagement from "./helpQueueAssignmentManagement";
import HelpRequestTemplateManagement from "./helpRequestTemplateManagement";
import ModerationManagement from "./moderationManagement";
import StudentKarmaManagement from "./studentKarmaManagement";
import StudentActivitySummary from "./studentActivitySummary";
import HelpRequestFeedback from "./feedback";
import TimeTrackingPage from "./time-tracking/page";
import { useIsInstructor } from "@/hooks/useClassProfiles";

/**
 * Comprehensive admin page for office hours management.
 * Provides tabbed interface for different management views.
 */
export default function OfficeHoursAdminPage() {
  const isInstructor = useIsInstructor();

  return (
    <Box>
      <Tabs.Root defaultValue="dashboard" variant="enclosed">
        <Box overflowX={{ base: "auto", md: "visible" }} overflowY="hidden" pb={{ base: 1, md: 0 }}>
          <Tabs.List
            display="inline-flex"
            flexWrap="nowrap"
            columnGap={{ base: 2, md: 3 }}
            px={{ base: 2, md: 0 }}
            minW="max-content"
          >
            <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="dashboard">
              TA Dashboard
            </Tabs.Trigger>
            <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="queues">
              Queue Management
            </Tabs.Trigger>
            <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="assignments">
              Assignment Management
            </Tabs.Trigger>
            <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="templates">
              Templates
            </Tabs.Trigger>
            <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="moderation">
              Moderation
            </Tabs.Trigger>
            <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="karma">
              Student Karma
            </Tabs.Trigger>
            <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="activity">
              Student Activity
            </Tabs.Trigger>
            <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="time-tracking">
              Time Tracking
            </Tabs.Trigger>
            {isInstructor && (
              <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="feedback">
                Feedback
              </Tabs.Trigger>
            )}
          </Tabs.List>
        </Box>

        <Box mt={{ base: 3, md: 6 }}>
          <Tabs.Content value="dashboard">
            <HelpQueuesDashboard />
          </Tabs.Content>

          <Tabs.Content value="queues">
            <HelpQueueManagement />
          </Tabs.Content>

          <Tabs.Content value="assignments">
            <HelpQueueAssignmentManagement />
          </Tabs.Content>

          <Tabs.Content value="templates">
            <HelpRequestTemplateManagement />
          </Tabs.Content>

          <Tabs.Content value="moderation">
            <ModerationManagement />
          </Tabs.Content>

          <Tabs.Content value="karma">
            <StudentKarmaManagement />
          </Tabs.Content>

          <Tabs.Content value="activity">
            <StudentActivitySummary />
          </Tabs.Content>

          <Tabs.Content value="time-tracking">
            <TimeTrackingPage />
          </Tabs.Content>

          {isInstructor && (
            <Tabs.Content value="feedback">
              <HelpRequestFeedback />
            </Tabs.Content>
          )}
        </Box>
      </Tabs.Root>
    </Box>
  );
}
