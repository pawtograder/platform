"use client";

import {
  Badge,
  Box,
  Card,
  Grid,
  HStack,
  Icon,
  Progress,
  SimpleGrid,
  Spinner,
  Stat,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useMemo } from "react";
import {
  FaChartBar,
  FaCheckCircle,
  FaExclamationTriangle,
  FaGraduationCap,
  FaTimesCircle,
  FaTrophy
} from "react-icons/fa";
import type { AssignmentTestStatistics, TestStatistics, SubmissionsToFullMarksResponse } from "./types";
import { getDifficultyLevel, DIFFICULTY_COLORS, DIFFICULTY_LABELS, SCORE_BUCKETS, SCORE_BUCKET_COLORS } from "./types";

interface TestInsightsOverviewProps {
  statistics: AssignmentTestStatistics | null;
  submissionsToFullMarks: SubmissionsToFullMarksResponse | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Overview component showing test difficulty metrics and statistics
 */
export function TestInsightsOverview({
  statistics,
  submissionsToFullMarks,
  isLoading,
  error
}: TestInsightsOverviewProps) {
  // Calculate summary metrics
  const summaryMetrics = useMemo(() => {
    if (!statistics) return null;

    const tests = statistics.tests;
    const avgPassRate = tests.length > 0 ? tests.reduce((sum, t) => sum + (t.pass_rate || 0), 0) / tests.length : 0;

    const hardestTest = tests.reduce(
      (hardest, test) => {
        if (!hardest || (test.pass_rate || 100) < (hardest.pass_rate || 100)) {
          return test;
        }
        return hardest;
      },
      null as TestStatistics | null
    );

    const easiestTest = tests.reduce(
      (easiest, test) => {
        if (!easiest || (test.pass_rate || 0) > (easiest.pass_rate || 0)) {
          return test;
        }
        return easiest;
      },
      null as TestStatistics | null
    );

    return {
      totalTests: tests.length,
      avgPassRate,
      hardestTest,
      easiestTest,
      totalSubmissions: statistics.total_active_submissions,
      submissionsWithResults: statistics.submissions_with_results
    };
  }, [statistics]);

  if (isLoading) {
    return (
      <Box p={8} textAlign="center">
        <Spinner size="xl" />
        <Text mt={4} color="fg.muted">
          Loading test statistics...
        </Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={8} textAlign="center" color="red.500">
        <Icon as={FaExclamationTriangle} boxSize={8} mb={4} />
        <Text>Failed to load test statistics</Text>
        <Text fontSize="sm" color="fg.muted">
          {error.message}
        </Text>
      </Box>
    );
  }

  if (!statistics || !summaryMetrics) {
    return (
      <Box p={8} textAlign="center" color="fg.muted">
        <Icon as={FaChartBar} boxSize={8} mb={4} />
        <Text>No test data available</Text>
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={6}>
      {/* Summary Cards */}
      <SimpleGrid columns={{ base: 1, md: 2, lg: 4 }} gap={4}>
        <Card.Root>
          <Card.Body>
            <Stat.Root>
              <HStack>
                <Icon as={FaGraduationCap} color="blue.500" />
                <Stat.Label>Total Submissions</Stat.Label>
              </HStack>
              <Stat.ValueText>{summaryMetrics.totalSubmissions}</Stat.ValueText>
              <Stat.HelpText>{summaryMetrics.submissionsWithResults} with results</Stat.HelpText>
            </Stat.Root>
          </Card.Body>
        </Card.Root>

        <Card.Root>
          <Card.Body>
            <Stat.Root>
              <HStack>
                <Icon as={FaChartBar} color="purple.500" />
                <Stat.Label>Tests Analyzed</Stat.Label>
              </HStack>
              <Stat.ValueText>{summaryMetrics.totalTests}</Stat.ValueText>
              <Stat.HelpText>Unique test cases</Stat.HelpText>
            </Stat.Root>
          </Card.Body>
        </Card.Root>

        <Card.Root>
          <Card.Body>
            <Stat.Root>
              <HStack>
                <Icon as={FaCheckCircle} color="green.500" />
                <Stat.Label>Avg Pass Rate</Stat.Label>
              </HStack>
              <Stat.ValueText>{summaryMetrics.avgPassRate.toFixed(1)}%</Stat.ValueText>
              <Stat.HelpText>Across all tests</Stat.HelpText>
            </Stat.Root>
          </Card.Body>
        </Card.Root>

        <Card.Root>
          <Card.Body>
            <Stat.Root>
              <HStack>
                <Icon as={FaExclamationTriangle} color="orange.500" />
                <Stat.Label>Hardest Test</Stat.Label>
              </HStack>
              <Stat.ValueText fontSize="md" truncate>
                {summaryMetrics.hardestTest?.name || "N/A"}
              </Stat.ValueText>
              <Stat.HelpText>{summaryMetrics.hardestTest?.pass_rate?.toFixed(1) || 0}% pass rate</Stat.HelpText>
            </Stat.Root>
          </Card.Body>
        </Card.Root>
      </SimpleGrid>

      {/* Overall Score Distribution */}
      {statistics.overall_score_distribution && (
        <Card.Root>
          <Card.Header>
            <HStack>
              <Icon as={FaChartBar} />
              <Text fontWeight="semibold">Overall Score Distribution</Text>
            </HStack>
          </Card.Header>
          <Card.Body>
            <ScoreDistributionChart distribution={statistics.overall_score_distribution} />
          </Card.Body>
        </Card.Root>
      )}

      {/* Test Performance Table */}
      <Card.Root>
        <Card.Header>
          <HStack justify="space-between">
            <HStack>
              <Icon as={FaTrophy} />
              <Text fontWeight="semibold">Test Performance Overview</Text>
            </HStack>
            <Text fontSize="sm" color="fg.muted">
              {statistics.tests.length} tests
            </Text>
          </HStack>
        </Card.Header>
        <Card.Body>
          <Box overflowX="auto">
            <Table.Root size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Test Name</Table.ColumnHeader>
                  <Table.ColumnHeader>Part</Table.ColumnHeader>
                  <Table.ColumnHeader>Difficulty</Table.ColumnHeader>
                  <Table.ColumnHeader>Pass Rate</Table.ColumnHeader>
                  <Table.ColumnHeader>Avg Score</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="right">Attempts</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="right">Passing</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="right">Failing</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {statistics.tests
                  .sort((a, b) => (a.pass_rate || 100) - (b.pass_rate || 100))
                  .map((test, idx) => {
                    const difficulty = getDifficultyLevel(test.pass_rate || 0);
                    return (
                      <Table.Row key={`${test.name}-${test.part}-${idx}`}>
                        <Table.Cell fontWeight="medium">{test.name}</Table.Cell>
                        <Table.Cell color="fg.muted">{test.part || "-"}</Table.Cell>
                        <Table.Cell>
                          <Badge
                            size="sm"
                            style={{
                              backgroundColor: DIFFICULTY_COLORS[difficulty],
                              color: "white"
                            }}
                          >
                            {DIFFICULTY_LABELS[difficulty]}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell>
                          <HStack gap={2}>
                            <Progress.Root
                              value={test.pass_rate || 0}
                              size="sm"
                              w="60px"
                              colorPalette={
                                (test.pass_rate || 0) >= 80 ? "green" : (test.pass_rate || 0) >= 50 ? "yellow" : "red"
                              }
                            >
                              <Progress.Track>
                                <Progress.Range />
                              </Progress.Track>
                            </Progress.Root>
                            <Text fontSize="sm">{(test.pass_rate || 0).toFixed(1)}%</Text>
                          </HStack>
                        </Table.Cell>
                        <Table.Cell>
                          {test.avg_score?.toFixed(1)} / {test.max_score}
                        </Table.Cell>
                        <Table.Cell textAlign="right">{test.total_attempts}</Table.Cell>
                        <Table.Cell textAlign="right">
                          <HStack justify="flex-end" gap={1}>
                            <Icon as={FaCheckCircle} color="green.500" boxSize={3} />
                            <Text>{test.passing_count}</Text>
                          </HStack>
                        </Table.Cell>
                        <Table.Cell textAlign="right">
                          <HStack justify="flex-end" gap={1}>
                            <Icon as={FaTimesCircle} color="red.500" boxSize={3} />
                            <Text>{test.failing_count}</Text>
                          </HStack>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
              </Table.Body>
            </Table.Root>
          </Box>
        </Card.Body>
      </Card.Root>

      {/* Submissions to Full Marks */}
      {submissionsToFullMarks && submissionsToFullMarks.overall && (
        <Card.Root>
          <Card.Header>
            <HStack>
              <Icon as={FaTrophy} color="yellow.500" />
              <Text fontWeight="semibold">Submissions to Full Marks</Text>
            </HStack>
          </Card.Header>
          <Card.Body>
            <SimpleGrid columns={{ base: 1, md: 2, lg: 4 }} gap={4} mb={4}>
              <Box p={4} bg="green.50" borderRadius="md" _dark={{ bg: "green.900" }}>
                <Text fontSize="sm" color="green.700" _dark={{ color: "green.200" }}>
                  Students with Full Marks
                </Text>
                <Text fontSize="2xl" fontWeight="bold" color="green.600" _dark={{ color: "green.300" }}>
                  {submissionsToFullMarks.overall.students_with_full_marks}
                </Text>
              </Box>
              <Box p={4} bg="red.50" borderRadius="md" _dark={{ bg: "red.900" }}>
                <Text fontSize="sm" color="red.700" _dark={{ color: "red.200" }}>
                  Students Without Full Marks
                </Text>
                <Text fontSize="2xl" fontWeight="bold" color="red.600" _dark={{ color: "red.300" }}>
                  {submissionsToFullMarks.overall.students_without_full_marks}
                </Text>
              </Box>
              <Box p={4} bg="blue.50" borderRadius="md" _dark={{ bg: "blue.900" }}>
                <Text fontSize="sm" color="blue.700" _dark={{ color: "blue.200" }}>
                  Avg Submissions to Full Marks
                </Text>
                <Text fontSize="2xl" fontWeight="bold" color="blue.600" _dark={{ color: "blue.300" }}>
                  {submissionsToFullMarks.overall.avg_submissions_to_full_marks?.toFixed(1) || "N/A"}
                </Text>
              </Box>
              <Box p={4} bg="purple.50" borderRadius="md" _dark={{ bg: "purple.900" }}>
                <Text fontSize="sm" color="purple.700" _dark={{ color: "purple.200" }}>
                  Median Submissions
                </Text>
                <Text fontSize="2xl" fontWeight="bold" color="purple.600" _dark={{ color: "purple.300" }}>
                  {submissionsToFullMarks.overall.median_submissions_to_full_marks?.toFixed(0) || "N/A"}
                </Text>
              </Box>
            </SimpleGrid>
          </Card.Body>
        </Card.Root>
      )}
    </VStack>
  );
}

/**
 * Score distribution bar chart component
 */
function ScoreDistributionChart({ distribution }: { distribution: Record<string, number> }) {
  const maxCount = Math.max(...Object.values(distribution), 1);

  return (
    <Grid templateColumns="repeat(auto-fit, minmax(80px, 1fr))" gap={2}>
      {SCORE_BUCKETS.map((bucket) => {
        const count = distribution[bucket] || 0;
        const percentage = (count / maxCount) * 100;

        return (
          <VStack key={bucket} gap={1}>
            <Box w="100%" h="100px" position="relative" bg="gray.100" borderRadius="md" _dark={{ bg: "gray.700" }}>
              <Box
                position="absolute"
                bottom={0}
                left={0}
                right={0}
                h={`${percentage}%`}
                bg={SCORE_BUCKET_COLORS[bucket]}
                borderRadius="md"
                transition="height 0.3s ease"
              />
            </Box>
            <Text fontSize="xs" fontWeight="medium">
              {bucket}%
            </Text>
            <Text fontSize="xs" color="fg.muted">
              {count}
            </Text>
          </VStack>
        );
      })}
    </Grid>
  );
}
