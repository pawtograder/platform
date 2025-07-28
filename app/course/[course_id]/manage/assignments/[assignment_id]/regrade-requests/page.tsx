"use client";

import { Box, Heading, VStack } from "@chakra-ui/react";
import RegradeRequestsTable from "./RegradeRequestsTable";

/**
 * Displays the regrade requests page with a heading and a table of regrade requests.
 *
 * Renders a vertically stacked layout containing a page title and the list of regrade requests for an assignment.
 */
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
