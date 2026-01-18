"use client";

import { Badge, Box, Button, Card, Code, Collapsible, HStack, Icon, Spinner, Text, VStack } from "@chakra-ui/react";
import { useCallback, useMemo, useState } from "react";
import { FaBug, FaChevronDown, FaChevronRight, FaExclamationTriangle, FaLink, FaUsers } from "react-icons/fa";
import { ErrorFilterPanel, DEFAULT_ERROR_FILTERS } from "./ErrorFilterPanel";
import type { CommonErrorGroup, CommonErrorsResponse, ErrorExplorerFilters, TestStatistics } from "./types";

interface CommonErrorsExplorerProps {
  data: CommonErrorsResponse | null;
  tests: TestStatistics[];
  isLoading: boolean;
  error: Error | null;
  filters: ErrorExplorerFilters;
  onFiltersChange: (filters: ErrorExplorerFilters) => void;
  onCreateErrorPin?: (errorGroup: CommonErrorGroup) => void;
  onViewSubmissions?: (submissionIds: number[]) => void;
}

/**
 * Explorer component for viewing and filtering common errors with deduplication
 */
export function CommonErrorsExplorer({
  data,
  tests,
  isLoading,
  error,
  filters,
  onFiltersChange,
  onCreateErrorPin,
  onViewSubmissions
}: CommonErrorsExplorerProps) {
  const [expandedError, setExpandedError] = useState<string | null>(null);

  // Filter and sort errors based on current filters
  const filteredErrors = useMemo(() => {
    if (!data?.common_errors) return [];

    let errors = [...data.common_errors];

    // Apply search filter
    if (filters.searchTerm) {
      const searchLower = filters.searchTerm.toLowerCase();
      errors = errors.filter(
        (e) =>
          e.error_signature.toLowerCase().includes(searchLower) ||
          e.test_name.toLowerCase().includes(searchLower) ||
          e.sample_outputs.some((o) => o.toLowerCase().includes(searchLower))
      );
    }

    // Apply sorting
    errors.sort((a, b) => {
      let comparison = 0;
      switch (filters.sortBy) {
        case "occurrence_count":
          comparison = a.occurrence_count - b.occurrence_count;
          break;
        case "avg_score":
          comparison = a.avg_score - b.avg_score;
          break;
        case "test_name":
          comparison = a.test_name.localeCompare(b.test_name);
          break;
      }
      return filters.sortDirection === "asc" ? comparison : -comparison;
    });

    return errors;
  }, [data, filters.searchTerm, filters.sortBy, filters.sortDirection]);

  const handleToggleExpand = useCallback((errorId: string) => {
    setExpandedError((prev) => (prev === errorId ? null : errorId));
  }, []);

  if (isLoading) {
    return (
      <Box p={8} textAlign="center">
        <Spinner size="xl" />
        <Text mt={4} color="fg.muted">
          Analyzing common errors...
        </Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={8} textAlign="center" color="red.500">
        <Icon as={FaExclamationTriangle} boxSize={8} mb={4} />
        <Text>Failed to load common errors</Text>
        <Text fontSize="sm" color="fg.muted">
          {error.message}
        </Text>
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={4}>
      {/* Filter Panel */}
      <ErrorFilterPanel filters={filters} onFiltersChange={onFiltersChange} tests={tests} showMinOccurrences={true} />

      {/* Results Summary */}
      <HStack justify="space-between" px={2}>
        <Text fontSize="sm" color="fg.muted">
          {filteredErrors.length} common error pattern{filteredErrors.length !== 1 ? "s" : ""} found
          {data?.total_error_groups && data.total_error_groups > filteredErrors.length && (
            <Text as="span">
              {" "}
              (showing top {filteredErrors.length} of {data.total_error_groups})
            </Text>
          )}
        </Text>
        {filters.testName && <Badge colorPalette="blue">Filtered by: {filters.testName}</Badge>}
      </HStack>

      {/* Error List */}
      {filteredErrors.length === 0 ? (
        <Box p={8} textAlign="center" color="fg.muted">
          <Icon as={FaBug} boxSize={8} mb={4} />
          <Text>No common errors found</Text>
          <Text fontSize="sm">Try adjusting the filters or lowering the minimum occurrences</Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={3}>
          {filteredErrors.map((errorGroup, idx) => (
            <ErrorGroupCard
              key={`${errorGroup.test_name}-${errorGroup.normalized_output.slice(0, 50)}-${idx}`}
              errorGroup={errorGroup}
              isExpanded={expandedError === `${errorGroup.test_name}-${idx}`}
              onToggle={() => handleToggleExpand(`${errorGroup.test_name}-${idx}`)}
              onCreateErrorPin={onCreateErrorPin}
              onViewSubmissions={onViewSubmissions}
            />
          ))}
        </VStack>
      )}
    </VStack>
  );
}

interface ErrorGroupCardProps {
  errorGroup: CommonErrorGroup;
  isExpanded: boolean;
  onToggle: () => void;
  onCreateErrorPin?: (errorGroup: CommonErrorGroup) => void;
  onViewSubmissions?: (submissionIds: number[]) => void;
}

function ErrorGroupCard({
  errorGroup,
  isExpanded,
  onToggle,
  onCreateErrorPin,
  onViewSubmissions
}: ErrorGroupCardProps) {
  return (
    <Card.Root
      borderColor={errorGroup.is_failing ? "red.200" : "border.muted"}
      _dark={{ borderColor: errorGroup.is_failing ? "red.700" : "border.muted" }}
    >
      <Card.Body p={0}>
        {/* Header - always visible */}
        <Box
          p={4}
          cursor="pointer"
          onClick={onToggle}
          _hover={{ bg: "bg.subtle" }}
          borderBottomWidth={isExpanded ? "1px" : "0"}
          borderColor="border.muted"
        >
          <HStack justify="space-between">
            <HStack gap={3} flex="1" overflow="hidden">
              <Icon as={isExpanded ? FaChevronDown : FaChevronRight} color="fg.muted" boxSize={3} />
              <Icon as={FaBug} color={errorGroup.is_failing ? "red.500" : "orange.500"} />
              <VStack align="start" gap={0} flex="1" overflow="hidden">
                <HStack gap={2} wrap="wrap">
                  <Text fontWeight="semibold" fontSize="sm">
                    {errorGroup.test_name}
                  </Text>
                  {errorGroup.test_part && (
                    <Badge size="sm" colorPalette="gray">
                      {errorGroup.test_part}
                    </Badge>
                  )}
                </HStack>
                <Text fontSize="xs" color="fg.muted" truncate maxW="100%">
                  {errorGroup.error_signature}
                </Text>
              </VStack>
            </HStack>

            <HStack gap={3} flexShrink={0}>
              <HStack gap={1}>
                <Icon as={FaUsers} color="fg.muted" boxSize={3} />
                <Badge colorPalette="purple" size="sm">
                  {errorGroup.occurrence_count} students
                </Badge>
              </HStack>
              <Badge colorPalette={errorGroup.is_failing ? "red" : "yellow"} size="sm">
                Avg: {errorGroup.avg_score}
              </Badge>
            </HStack>
          </HStack>
        </Box>

        {/* Expanded Content */}
        <Collapsible.Root open={isExpanded}>
          <Collapsible.Content>
            <Box p={4} bg="bg.subtle">
              <VStack align="stretch" gap={4}>
                {/* Sample Outputs */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={2}>
                    Sample Error Output{errorGroup.sample_outputs.length > 1 ? "s" : ""}
                  </Text>
                  <VStack align="stretch" gap={2}>
                    {errorGroup.sample_outputs.map((output, idx) => (
                      <Code
                        key={idx}
                        display="block"
                        whiteSpace="pre-wrap"
                        p={3}
                        fontSize="xs"
                        borderRadius="md"
                        overflow="auto"
                        maxH="200px"
                      >
                        {output}
                      </Code>
                    ))}
                  </VStack>
                </Box>

                {/* Actions */}
                <HStack justify="flex-end" gap={2}>
                  {onViewSubmissions && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onViewSubmissions(errorGroup.affected_submission_ids)}
                    >
                      <Icon as={FaUsers} mr={2} />
                      View {errorGroup.affected_submission_ids.length} Submissions
                    </Button>
                  )}
                  {onCreateErrorPin && (
                    <Button size="sm" colorPalette="blue" onClick={() => onCreateErrorPin(errorGroup)}>
                      <Icon as={FaLink} mr={2} />
                      Create Error Pin
                    </Button>
                  )}
                </HStack>
              </VStack>
            </Box>
          </Collapsible.Content>
        </Collapsible.Root>
      </Card.Body>
    </Card.Root>
  );
}

export { DEFAULT_ERROR_FILTERS };
