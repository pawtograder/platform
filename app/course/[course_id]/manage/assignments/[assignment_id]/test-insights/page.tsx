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
import { Box, Heading, HStack, Icon, Tabs, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { FaBug, FaChartBar, FaExclamationTriangle } from "react-icons/fa";

export default function TestInsightsPage() {
  const { course_id, assignment_id } = useParams();
  const assignmentId = Number(assignment_id);
  const courseId = Number(course_id);

  // State for filters - must be called unconditionally
  const [filters, setFilters] = useState<ErrorExplorerFilters>(DEFAULT_ERROR_FILTERS);
  const [activeTab, setActiveTab] = useState<string>("overview");
  const [selectedErrorForPin, setSelectedErrorForPin] = useState<CommonErrorGroup | null>(null);

  // Validate route params - pass null to hooks if invalid
  const validAssignmentId = Number.isFinite(assignmentId) ? assignmentId : null;
  const validCourseId = Number.isFinite(courseId) ? courseId : null;

  // Fetch data - hooks handle null assignment_id gracefully
  const { data: statistics, isLoading: isLoadingStats, error: statsError } = useTestStatistics(validAssignmentId);
  const {
    data: submissionsToFullMarks,
    isLoading: isLoadingFullMarks,
    error: fullMarksError
  } = useSubmissionsToFullMarks(validAssignmentId);
  const {
    data: commonErrors,
    isLoading: isLoadingErrors,
    error: errorsError
  } = useCommonErrors(validAssignmentId, filters.testName, filters.testPart, filters.minOccurrences, 50);

  // Handle creating an error pin from a common error
  const handleCreateErrorPin = useCallback((errorGroup: CommonErrorGroup) => {
    setSelectedErrorForPin(errorGroup);
  }, []);

  // Handle viewing submissions for a common error - placeholder for future implementation
  const handleViewSubmissions = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (submissionIds: number[]) => {
      // TODO: Navigate to the assignments table with a filter for these submissions
      // Could use router.push with query params to filter the assignments table
    },
    []
  );

  // Handle closing the error pin modal
  const handleCloseErrorPinModal = useCallback(() => {
    setSelectedErrorForPin(null);
  }, []);

  // Render error UI if params are invalid
  if (!validAssignmentId || !validCourseId) {
    return (
      <Box p={8} textAlign="center" color="red.500">
        <Icon as={FaExclamationTriangle} boxSize={8} mb={4} />
        <Text fontWeight="semibold">Invalid Parameters</Text>
        <Text fontSize="sm" color="fg.muted">
          The assignment or course ID is invalid.
        </Text>
      </Box>
    );
  }

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
      <Tabs.Root value={activeTab} onValueChange={(details) => setActiveTab(details.value)} variant="line">
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
              error={statsError || fullMarksError}
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
          assignmentId={validAssignmentId}
          courseId={validCourseId}
          errorGroup={selectedErrorForPin}
          isOpen={true}
          onClose={handleCloseErrorPinModal}
        />
      )}
    </VStack>
  );
}
