"use client";

import { Container, VStack } from "@chakra-ui/react";
import RosterTokensTable from "../tables/rosterTokensTable";

/**
 * Roster Tokens page - manages late tokens for students in the course.
 */
export default function RosterTokensPage() {
  return (
    <Container>
      <VStack align="stretch" gap={6} py={4}>
        <RosterTokensTable />
      </VStack>
    </Container>
  );
}
