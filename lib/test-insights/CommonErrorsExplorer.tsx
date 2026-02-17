"use client";

import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import {
  Badge,
  Box,
  Button,
  Card,
  Code,
  Collapsible,
  HStack,
  Icon,
  Spinner,
  Text,
  Textarea,
  VStack
} from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaBug,
  FaChevronDown,
  FaChevronRight,
  FaCopy,
  FaEnvelope,
  FaExclamationTriangle,
  FaLink,
  FaPlay,
  FaUsers
} from "react-icons/fa";
import { ErrorFilterPanel, DEFAULT_ERROR_FILTERS } from "./ErrorFilterPanel";
import { AIHelpTestErrorButton } from "./AIHelpTestErrorButton";
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
  onRegradeSubmissions?: (errorGroup: CommonErrorGroup) => void;
  /** Assignment ID for AI help context */
  assignmentId?: number;
  /** Class ID for AI help context */
  classId?: number;
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
  onViewSubmissions,
  onRegradeSubmissions,
  assignmentId,
  classId
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
              onRegradeSubmissions={onRegradeSubmissions}
              assignmentId={assignmentId}
              classId={classId}
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
  onRegradeSubmissions?: (errorGroup: CommonErrorGroup) => void;
  assignmentId?: number;
  classId?: number;
}

function ErrorGroupCard({
  errorGroup,
  isExpanded,
  onToggle,
  onCreateErrorPin,
  onViewSubmissions,
  onRegradeSubmissions,
  assignmentId,
  classId
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
                  {errorGroup.affected_submission_ids.length} submission
                  {errorGroup.affected_submission_ids.length !== 1 ? "s" : ""}
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

                {/* Affected Student Emails */}
                <AffectedStudentsEmails submissionIds={errorGroup.affected_submission_ids} />

                {/* Actions */}
                <HStack justify="flex-end" gap={2} flexWrap="wrap">
                  {assignmentId && classId && (
                    <AIHelpTestErrorButton
                      errorGroup={errorGroup}
                      assignmentId={assignmentId}
                      classId={classId}
                      size="sm"
                      variant="outline"
                    />
                  )}
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
                  {onRegradeSubmissions && (
                    <Button size="sm" colorPalette="green" onClick={() => onRegradeSubmissions(errorGroup)}>
                      <Icon as={FaPlay} mr={2} />
                      Regrade Submissions
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

/**
 * Component to fetch and display student emails for affected submissions
 */
function AffectedStudentsEmails({ submissionIds }: { submissionIds: number[] }) {
  const [emails, setEmails] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (!isExpanded || submissionIds.length === 0) return;

    let cancelled = false;

    async function fetchEmails() {
      setIsLoading(true);
      setError(null);

      try {
        const supabase = createClient();

        // Step 1: Get profile_ids from submissions
        const { data: submissions, error: submissionsError } = await supabase
          .from("submissions")
          .select("id, profile_id")
          .in("id", submissionIds);

        if (submissionsError) throw submissionsError;
        if (!submissions || submissions.length === 0) {
          if (!cancelled) setEmails([]);
          return;
        }

        // Get unique profile IDs
        const profileIds = [...new Set(submissions.map((s) => s.profile_id).filter(Boolean))] as string[];

        if (profileIds.length === 0) {
          if (!cancelled) setEmails([]);
          return;
        }

        // Step 2: Get user emails via user_roles
        const { data: userRoles, error: rolesError } = await supabase
          .from("user_roles")
          .select("private_profile_id, users(email)")
          .in("private_profile_id", profileIds);

        if (rolesError) throw rolesError;

        if (!cancelled) {
          // Extract unique emails
          const emailSet = new Set<string>();
          userRoles?.forEach((role) => {
            const users = role.users as unknown as { email: string } | null;
            if (users?.email) {
              emailSet.add(users.email);
            }
          });
          setEmails(Array.from(emailSet).sort());
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to fetch emails");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void fetchEmails();

    return () => {
      cancelled = true;
    };
  }, [isExpanded, submissionIds]);

  const handleCopyEmails = useCallback(async () => {
    if (emails.length === 0) return;

    try {
      await navigator.clipboard.writeText(emails.join(", "));
      toaster.success({
        title: "Copied!",
        description: `${emails.length} email${emails.length !== 1 ? "s" : ""} copied to clipboard`
      });
    } catch {
      toaster.error({
        title: "Failed to copy",
        description: "Could not copy emails to clipboard"
      });
    }
  }, [emails]);

  return (
    <Box>
      <Button size="sm" variant="outline" onClick={() => setIsExpanded(!isExpanded)} mb={isExpanded ? 2 : 0}>
        <Icon as={FaEnvelope} mr={2} />
        {isExpanded ? "Hide" : "Show"} Student Emails
      </Button>

      {isExpanded && (
        <Box p={3} bg="bg.muted" borderRadius="md" borderWidth="1px" borderColor="border.muted">
          {isLoading ? (
            <HStack justify="center" p={2}>
              <Spinner size="sm" />
              <Text fontSize="sm" color="fg.muted">
                Loading emails...
              </Text>
            </HStack>
          ) : error ? (
            <Text fontSize="sm" color="fg.error">
              {error}
            </Text>
          ) : emails.length === 0 ? (
            <Text fontSize="sm" color="fg.muted">
              No emails found for affected students
            </Text>
          ) : (
            <VStack align="stretch" gap={2}>
              <HStack justify="space-between">
                <Text fontSize="sm" fontWeight="medium">
                  {emails.length} student email{emails.length !== 1 ? "s" : ""}
                </Text>
                <Button size="xs" variant="outline" onClick={handleCopyEmails}>
                  <Icon as={FaCopy} mr={1} />
                  Copy All
                </Button>
              </HStack>
              <Textarea
                value={emails.join(", ")}
                readOnly
                fontSize="xs"
                fontFamily="mono"
                rows={Math.min(4, Math.ceil(emails.length / 2))}
                resize="vertical"
                bg="bg.subtle"
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              />
            </VStack>
          )}
        </Box>
      )}
    </Box>
  );
}

export { DEFAULT_ERROR_FILTERS };
