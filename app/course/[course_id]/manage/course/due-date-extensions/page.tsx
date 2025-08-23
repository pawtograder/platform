"use client";

import { Container, Heading, VStack, Box } from "@chakra-ui/react";
import DueDateExceptionsTable from "./tables/dueDateExceptionsTable";
import StudentExtensionsTable from "./tables/studentExtensionsTable";

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
        <Box>
          <DueDateExceptionsTable />
        </Box>
        <Box>
          <StudentExtensionsTable />
        </Box>
      </VStack>
    </Container>
  );
}
