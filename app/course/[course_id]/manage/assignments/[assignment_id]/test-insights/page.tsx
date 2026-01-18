"use client";

import { useTestStatistics, useCommonErrors, useSubmissionsToFullMarks } from "@/hooks/useTestInsights";
import {
  TestInsightsOverview,
  CommonErrorsExplorer,
  ErrorPinIntegration,
  DEFAULT_ERROR_FILTERS,
  type ErrorExplorerFilters,
  type CommonErrorGroup
} from "@/lib/test-insights";
import {
  Box,
  Heading,
  HStack,
  Icon,
  Tab,
  Tabs,
  Text,
  VStack
} from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { FaBug, FaChartBar, FaLink } from "react-icons/fa";

export default function TestInsightsPage() {
  const { course_id, assignment_id } = useParams();
  const router = useRouter();
  const assignmentId = Number(assignment_id);
  const courseId = Number(course_id);

  // State for filters
  const [filters, setFilters] = useState<ErrorExplorerFilters>(DEFAULT_ERROR_FILTERS);
  const [activeTab, setActiveTab] = useState<string>("overview");
  const [selectedErrorForPin, setSelectedErrorForPin] = useState<CommonErrorGroup | null>(null);

  // Fetch data
  const { data: statistics, isLoading: isLoadingStats, error: statsError } = useTestStatistics(assignmentId);
  const { data: submissionsToFullMarks, isLoading: isLoadingFullMarks } = useSubmissionsToFullMarks(assignmentId);
  const {
    data: commonErrors,
    isLoading: isLoadingErrors,
    error: errorsError
  } = useCommonErrors(assignmentId, filters.testName, filters.testPart, filters.minOccurrences, 50);

  // Handle creating an error pin from a common error
  const handleCreateErrorPin = useCallback((errorGroup: CommonErrorGroup) => {
    setSelectedErrorForPin(errorGroup);
  }, []);

  // Handle viewing submissions for a common error
  const handleViewSubmissions = useCallback(
    (submissionIds: number[]) => {
      // Navigate to the assignments table with a filter for these submissions
      // For now, just log - we can enhance this to use query params
      // eslint-disable-next-line no-console
      console.log("View submissions:", submissionIds);
      // Could navigate with query params to filter the assignments table
    },
    []
  );

  const handleCloseErrorPinModal = useCallback(() => {
    setSelectedErrorForPin(null);
  }, []);

  return (
    <VStack align="stretch" gap={6} p={4}>
      {/* Page Header */}
      <Box>
        <Heading size="lg" mb={2}>
          <HStack>
            <Icon as={FaChartBar} />
            <Text>Test Insights</Text>
          </HStack>
        </Heading>
        <Text color="fg.muted">
          Analyze test performance, identify common errors, and link discussion posts to help students.
        </Text>
      </Box>

      {/* Tab Navigation */}
      <Tabs.Root
        value={activeTab}
        onValueChange={(details) => setActiveTab(details.value)}
        variant="line"
      >
        <Tabs.List>
          <Tabs.Trigger value="overview">
            <HStack>
              <Icon as={FaChartBar} />
              <Text>Performance Overview</Text>
            </HStack>
          </Tabs.Trigger>
          <Tabs.Trigger value="errors">
            <HStack>
              <Icon as={FaBug} />
              <Text>Common Errors</Text>
              {commonErrors?.total_error_groups && (
                <Text as="span" fontSize="sm" color="fg.muted">
                  ({commonErrors.total_error_groups})
                </Text>
              )}
            </HStack>
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="overview">
          <Box pt={4}>
            <TestInsightsOverview
              statistics={statistics}
              submissionsToFullMarks={submissionsToFullMarks}
              isLoading={isLoadingStats || isLoadingFullMarks}
              error={statsError}
            />
          </Box>
        </Tabs.Content>

        <Tabs.Content value="errors">
          <Box pt={4}>
            <CommonErrorsExplorer
              data={commonErrors}
              tests={statistics?.tests || []}
              isLoading={isLoadingErrors}
              error={errorsError}
              filters={filters}
              onFiltersChange={setFilters}
              onCreateErrorPin={handleCreateErrorPin}
              onViewSubmissions={handleViewSubmissions}
            />
          </Box>
        </Tabs.Content>
      </Tabs.Root>

      {/* Error Pin Creation Modal */}
      {selectedErrorForPin && (
        <ErrorPinIntegration
          assignmentId={assignmentId}
          courseId={courseId}
          errorGroup={selectedErrorForPin}
          isOpen={true}
          onClose={handleCloseErrorPinModal}
        />
      )}
    </VStack>
  );
}
