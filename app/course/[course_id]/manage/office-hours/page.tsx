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
        <Tabs.List
          overflowX={{ base: "auto", md: "visible" }}
          whiteSpace={{ base: "nowrap", md: "normal" }}
          display="flex"
          columnGap={{ base: 2, md: 3 }}
          px={{ base: 2, md: 0 }}
        >
          <Tabs.Trigger value="dashboard">TA Dashboard</Tabs.Trigger>
          <Tabs.Trigger value="queues">Queue Management</Tabs.Trigger>
          <Tabs.Trigger value="assignments">Assignment Management</Tabs.Trigger>
          <Tabs.Trigger value="templates">Templates</Tabs.Trigger>
          <Tabs.Trigger value="moderation">Moderation</Tabs.Trigger>
          <Tabs.Trigger value="karma">Student Karma</Tabs.Trigger>
          <Tabs.Trigger value="activity">Student Activity</Tabs.Trigger>
          {isInstructor && <Tabs.Trigger value="feedback">Feedback</Tabs.Trigger>}
        </Tabs.List>

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
