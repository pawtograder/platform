"use client";

import { Container, VStack } from "@chakra-ui/react";
import StudentExtensionsTable from "../tables/studentExtensionsTable";

/**
 * Student Extensions page - manages student-wide deadline extensions that apply to all assignments.
 */
export default function StudentExtensionsPage() {
  return (
    <Container>
      <VStack align="stretch" gap={6} py={4}>
        <StudentExtensionsTable />
      </VStack>
    </Container>
  );
}
