"use client";

import { Box, Heading, VStack } from "@chakra-ui/react";
import RegradeRequestsTable from "./RegradeRequestsTable";

export default function RegradeRequestsPage() {
  return (
    <VStack align="stretch" gap={6} w="100%">
      <Box>
        <Heading size="lg">Regrade Requests</Heading>
      </Box>
      <RegradeRequestsTable />
    </VStack>
  );
}
