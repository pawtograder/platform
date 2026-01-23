"use client";

import { useTestStatistics, useCommonErrors, useSubmissionsToFullMarks } from "@/hooks/useTestInsights";
import {
  TestInsightsOverview,
  CommonErrorsExplorer,
  ErrorPinIntegration,
  RegradeSubmissionsDialog,
  DEFAULT_ERROR_FILTERS,
  type ErrorExplorerFilters,
  type CommonErrorGroup
} from "@/lib/test-insights";
import { toaster } from "@/components/ui/toaster";
import { Box, Heading, HStack, Icon, Tabs, Text, VStack } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { FaBug, FaChartBar, FaExclamationTriangle } from "react-icons/fa";

export default function TestInsightsPage() {
  const { course_id, assignment_id } = useParams();
  const router = useRouter();
  const assignmentId = Number(assignment_id);
  const courseId = Number(course_id);

  // State for filters - must be called unconditionally
  const [filters, setFilters] = useState<ErrorExplorerFilters>(DEFAULT_ERROR_FILTERS);
  const [activeTab, setActiveTab] = useState<string>("overview");
  const [selectedErrorForPin, setSelectedErrorForPin] = useState<CommonErrorGroup | null>(null);
  const [selectedErrorForRegrade, setSelectedErrorForRegrade] = useState<CommonErrorGroup | null>(null);

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

  // Handle viewing submissions for a common error
  const handleViewSubmissions = useCallback(
    (submissionIds: number[]) => {
      // Store submission IDs in sessionStorage so the rerun-autograder page can pre-select them
      sessionStorage.setItem("preselect_submission_ids", JSON.stringify(submissionIds));
      
      // Navigate to the rerun-autograder page
      router.push(`/course/${course_id}/manage/assignments/${assignment_id}/rerun-autograder`);
      
      toaster.info({
        title: "Navigating to Rerun Autograder",
        description: `${submissionIds.length} submissions will be pre-selected for review.`
      });
    },
    [router, course_id, assignment_id]
  );

  // Handle closing the error pin modal
  const handleCloseErrorPinModal = useCallback(() => {
    setSelectedErrorForPin(null);
  }, []);

  // Handle regrading submissions for a common error
  const handleRegradeSubmissions = useCallback((errorGroup: CommonErrorGroup) => {
    setSelectedErrorForRegrade(errorGroup);
  }, []);

  // Handle closing the regrade modal
  const handleCloseRegradeModal = useCallback(() => {
    setSelectedErrorForRegrade(null);
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
              onRegradeSubmissions={handleRegradeSubmissions}
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

      {/* Regrade Submissions Modal */}
      {selectedErrorForRegrade && (
        <RegradeSubmissionsDialog
          assignmentId={validAssignmentId}
          courseId={validCourseId}
          errorGroup={selectedErrorForRegrade}
          isOpen={true}
          onClose={handleCloseRegradeModal}
        />
      )}
    </VStack>
  );
}
