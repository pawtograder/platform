"use client";

import { Container, Heading, VStack, Box, Tabs } from "@chakra-ui/react";
import DueDateExceptionsTable from "./tables/dueDateExceptionsTable";
import StudentExtensionsTable from "./tables/studentExtensionsTable";
import ClassLateTokenSettings from "./classLateTokenSettings";
import RosterTokensTable from "./tables/rosterTokensTable";

/**
 * Course-level Due Date Extensions dashboard.
 * - All assignment-level exceptions grouped by assignment with filters and actions
 * - Student-wide extensions for applying hours across all assignments
 */
export default function DueDateExtensionsPage() {
  return (
    <Container>
      <VStack align="stretch" gap={6} py={4}>
        <Heading>Due Date Extensions</Heading>
        <Tabs.Root defaultValue="exceptions" variant="enclosed">
          <Box overflowX={{ base: "auto", md: "visible" }} overflowY="hidden" pb={{ base: 1, md: 0 }}>
            <Tabs.List
              display="inline-flex"
              flexWrap="nowrap"
              columnGap={{ base: 2, md: 3 }}
              px={{ base: 2, md: 0 }}
              minW="max-content"
            >
              <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="exceptions">
                Assignment Exceptions
              </Tabs.Trigger>
              <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="student-extensions">
                Student Extensions
              </Tabs.Trigger>
              <Tabs.Trigger flexShrink={0} whiteSpace="nowrap" value="roster-tokens">
                Roster Tokens
              </Tabs.Trigger>
            </Tabs.List>
          </Box>
          <Box mt={{ base: 3, md: 6 }}>
            <Tabs.Content value="exceptions" display="flex" flexDirection="column" gap={4}>
              <ClassLateTokenSettings />
              <DueDateExceptionsTable />
            </Tabs.Content>
            <Tabs.Content value="student-extensions">
              <StudentExtensionsTable />
            </Tabs.Content>
            <Tabs.Content value="roster-tokens">
              <RosterTokensTable />
            </Tabs.Content>
          </Box>
        </Tabs.Root>
      </VStack>
    </Container>
  );
}
