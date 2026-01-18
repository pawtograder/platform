"use client";

import { Box, HStack, Icon, Input, NativeSelect, Stack, Text, VStack } from "@chakra-ui/react";
import { useCallback, useMemo } from "react";
import { FaFilter, FaSearch, FaSort } from "react-icons/fa";
import type { ErrorExplorerFilters, TestStatistics } from "./types";

interface ErrorFilterPanelProps {
  filters: ErrorExplorerFilters;
  onFiltersChange: (filters: ErrorExplorerFilters) => void;
  tests: TestStatistics[];
  showMinOccurrences?: boolean;
}

/**
 * Shared filter panel component for error exploration.
 * Can be used by both the test insights dashboard and error pin creation flow.
 */
export function ErrorFilterPanel({
  filters,
  onFiltersChange,
  tests,
  showMinOccurrences = true
}: ErrorFilterPanelProps) {
  // Get unique test names and parts
  const testNames = useMemo(() => {
    const names = new Set(tests.map((t) => t.name));
    return Array.from(names).sort();
  }, [tests]);

  const testParts = useMemo(() => {
    const parts = new Set(tests.filter((t) => t.part !== null).map((t) => t.part!));
    return Array.from(parts).sort();
  }, [tests]);

  const handleTestNameChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value || null;
      onFiltersChange({ ...filters, testName: value });
    },
    [filters, onFiltersChange]
  );

  const handleTestPartChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value || null;
      onFiltersChange({ ...filters, testPart: value });
    },
    [filters, onFiltersChange]
  );

  const handleMinOccurrencesChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10) || 1;
      onFiltersChange({ ...filters, minOccurrences: Math.max(1, value) });
    },
    [filters, onFiltersChange]
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onFiltersChange({ ...filters, searchTerm: e.target.value });
    },
    [filters, onFiltersChange]
  );

  const handleSortByChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onFiltersChange({
        ...filters,
        sortBy: e.target.value as ErrorExplorerFilters["sortBy"]
      });
    },
    [filters, onFiltersChange]
  );

  const handleSortDirectionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onFiltersChange({
        ...filters,
        sortDirection: e.target.value as ErrorExplorerFilters["sortDirection"]
      });
    },
    [filters, onFiltersChange]
  );

  return (
    <Box p={4} bg="bg.subtle" borderRadius="md" borderWidth="1px" borderColor="border.muted">
      <HStack mb={3} gap={2}>
        <Icon as={FaFilter} color="fg.muted" />
        <Text fontWeight="semibold" fontSize="sm">
          Filter Errors
        </Text>
      </HStack>

      <Stack direction={{ base: "column", md: "row" }} gap={4}>
        {/* Test Name Filter */}
        <VStack align="stretch" flex="1">
          <Text fontSize="xs" color="fg.muted" fontWeight="medium" id="test-name-label">
            Test Name
          </Text>
          <NativeSelect.Root size="sm">
            <NativeSelect.Field
              value={filters.testName || ""}
              onChange={handleTestNameChange}
              aria-label="Test Name"
              aria-labelledby="test-name-label"
            >
              <option value="">All Tests</option>
              {testNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </NativeSelect.Field>
          </NativeSelect.Root>
        </VStack>

        {/* Test Part Filter */}
        {testParts.length > 0 && (
          <VStack align="stretch" flex="1">
            <Text fontSize="xs" color="fg.muted" fontWeight="medium" id="test-part-label">
              Test Part
            </Text>
            <NativeSelect.Root size="sm">
              <NativeSelect.Field
                value={filters.testPart || ""}
                onChange={handleTestPartChange}
                aria-label="Test Part"
                aria-labelledby="test-part-label"
              >
                <option value="">All Parts</option>
                {testParts.map((part) => (
                  <option key={part} value={part}>
                    {part}
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </VStack>
        )}

        {/* Min Occurrences Filter */}
        {showMinOccurrences && (
          <VStack align="stretch" w={{ base: "100%", md: "120px" }}>
            <Text fontSize="xs" color="fg.muted" fontWeight="medium" id="min-occurrences-label">
              Min Occurrences
            </Text>
            <Input
              size="sm"
              type="number"
              min={1}
              value={filters.minOccurrences}
              onChange={handleMinOccurrencesChange}
              aria-label="Min Occurrences"
              aria-labelledby="min-occurrences-label"
            />
          </VStack>
        )}

        {/* Search Filter */}
        <VStack align="stretch" flex="1">
          <Text fontSize="xs" color="fg.muted" fontWeight="medium" id="search-output-label">
            Search Output
          </Text>
          <HStack>
            <Icon as={FaSearch} color="fg.muted" aria-hidden="true" />
            <Input
              size="sm"
              placeholder="Search error output..."
              value={filters.searchTerm}
              onChange={handleSearchChange}
              aria-label="Search Output"
              aria-labelledby="search-output-label"
            />
          </HStack>
        </VStack>
      </Stack>

      {/* Sort Options */}
      <HStack mt={4} gap={4}>
        <Icon as={FaSort} color="fg.muted" aria-hidden="true" />
        <VStack align="stretch" flex="1">
          <Text fontSize="xs" color="fg.muted" fontWeight="medium" id="sort-by-label">
            Sort By
          </Text>
          <NativeSelect.Root size="sm">
            <NativeSelect.Field
              value={filters.sortBy}
              onChange={handleSortByChange}
              aria-label="Sort By"
              aria-labelledby="sort-by-label"
            >
              <option value="occurrence_count">Occurrence Count</option>
              <option value="avg_score">Average Score</option>
              <option value="test_name">Test Name</option>
            </NativeSelect.Field>
          </NativeSelect.Root>
        </VStack>

        <VStack align="stretch" w={{ base: "100%", md: "120px" }}>
          <Text fontSize="xs" color="fg.muted" fontWeight="medium" id="sort-direction-label">
            Direction
          </Text>
          <NativeSelect.Root size="sm">
            <NativeSelect.Field
              value={filters.sortDirection}
              onChange={handleSortDirectionChange}
              aria-label="Sort Direction"
              aria-labelledby="sort-direction-label"
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </NativeSelect.Field>
          </NativeSelect.Root>
        </VStack>
      </HStack>
    </Box>
  );
}

/**
 * Default filter state
 */
export const DEFAULT_ERROR_FILTERS: ErrorExplorerFilters = {
  testName: null,
  testPart: null,
  minOccurrences: 2,
  searchTerm: "",
  sortBy: "occurrence_count",
  sortDirection: "desc"
};
