import { Box, Tabs } from "@chakra-ui/react";
import HelpQueuesDashboard from "./helpQueuesDashboard";
import HelpQueueManagement from "./helpQueueManagement";
import HelpQueueAssignmentManagement from "./helpQueueAssignmentManagement";
import HelpRequestTemplateManagement from "./helpRequestTemplateManagement";
import ModerationManagement from "./moderationManagement";
import StudentKarmaManagement from "./studentKarmaManagement";
import StudentActivitySummary from "./studentActivitySummary";

/**
 * Comprehensive admin page for office hours management.
 * Provides tabbed interface for different management views.
 */
export default function OfficeHoursAdminPage() {
  return (
    <Box>
      <Tabs.Root defaultValue="dashboard" variant="enclosed">
        <Tabs.List>
          <Tabs.Trigger value="dashboard">TA Dashboard</Tabs.Trigger>
          <Tabs.Trigger value="queues">Queue Management</Tabs.Trigger>
          <Tabs.Trigger value="assignments">Assignment Management</Tabs.Trigger>
          <Tabs.Trigger value="templates">Templates</Tabs.Trigger>
          <Tabs.Trigger value="moderation">Moderation</Tabs.Trigger>
          <Tabs.Trigger value="karma">Student Karma</Tabs.Trigger>
          <Tabs.Trigger value="activity">Student Activity</Tabs.Trigger>
        </Tabs.List>

        <Box mt={6}>
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
        </Box>
      </Tabs.Root>
    </Box>
  );
}
