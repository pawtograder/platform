import { Box, Heading, Text, VStack } from "@chakra-ui/react";
import CourseRegradeRequestsTable from "./CourseRegradeRequestsTable";

/**
 * Course-wide regrade request list for staff (same filters and deep links as per-assignment view).
 */
export default async function ManageCourseRegradeRequestsPage() {
  return (
    <VStack align="stretch" gap={6} w="100%">
      <Box>
        <Heading size="lg">All regrade requests</Heading>
        <Text color="fg.muted" fontSize="sm" mt={1}>
          Every regrade request across assignments. By default, draft and resolved rows are hidden; turn that off to see
          the full history.
        </Text>
      </Box>
      <CourseRegradeRequestsTable />
    </VStack>
  );
}
