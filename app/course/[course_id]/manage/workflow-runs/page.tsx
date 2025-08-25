"use client";

import { Box, Heading, Text, HStack, Spinner } from "@chakra-ui/react";
import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export default function WorkflowRunsOverviewPage() {
  return (
    <Box>
      <Heading as="h1" size="lg" mb={4}>
        Workflow Management Overview
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={6}>
        Monitor GitHub Actions workflows, track execution statistics, and manage grading errors across all student
        submissions.
      </Text>
      <WorkflowRunStats />
    </Box>
  );
}

function WorkflowRunStats() {
  const { course_id } = useParams();
  const [stats, setStats] = useState<Array<{
    name: string;
    total: number;
    avgQueue: number;
    avgRun: number;
    errorCount: number;
  }> | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      setIsLoading(true);
      try {
        const client = createClient();

        // Get current time for calculations
        const now = new Date();
        const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const timePeriods = [
          { name: "Last 30 minutes", start: thirtyMinutesAgo },
          { name: "Last hour", start: oneHourAgo },
          { name: "Today", start: todayStart },
          { name: "This week", start: weekStart },
          { name: "This month", start: monthStart },
          { name: "All time", start: new Date(0) }
        ];

        const statsData = await Promise.all(
          timePeriods.map(async (period) => {
            // Fetch workflow run statistics
            const { data: workflowData, error: workflowError } = await client
              .from("workflow_events_summary")
              .select("queue_time_seconds, run_time_seconds")
              .eq("class_id", Number(course_id))
              .gte("requested_at", period.start.toISOString());

            // Fetch error count for the same period
            const { data: errorData, error: errorError } = await client
              .from("workflow_run_error")
              .select("id")
              .eq("class_id", Number(course_id))
              .gte("created_at", period.start.toISOString());

            if (workflowError) {
              console.error(`Error fetching workflow stats for ${period.name}:`, workflowError);
            }

            if (errorError) {
              console.error(`Error fetching error stats for ${period.name}:`, errorError);
            }

            const runs = workflowData || [];
            const errors = errorData || [];
            const total = runs.length;
            const errorCount = errors.length;

            const queueTimes = runs.map((r) => r.queue_time_seconds).filter((t) => t !== null);
            const runTimes = runs.map((r) => r.run_time_seconds).filter((t) => t !== null);

            const avgQueue =
              queueTimes.length > 0 ? queueTimes.reduce((sum, time) => sum + time, 0) / queueTimes.length : 0;

            const avgRun = runTimes.length > 0 ? runTimes.reduce((sum, time) => sum + time, 0) / runTimes.length : 0;

            return {
              name: period.name,
              total,
              avgQueue: Math.round(avgQueue),
              avgRun: Math.round(avgRun),
              errorCount
            };
          })
        );

        setStats(statsData);
      } catch (error) {
        console.error("Error fetching workflow stats:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchStats();
  }, [course_id]);

  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
  };

  if (isLoading) {
    return (
      <Box>
        <Heading size="md" mb={4}>
          Workflow Statistics
        </Heading>
        <Spinner size="sm" />
      </Box>
    );
  }

  if (!stats) {
    return null;
  }

  return (
    <Box>
      <Heading size="md" mb={4}>
        Workflow Statistics
      </Heading>
      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(350px, 1fr))" gap={4}>
        {stats.map((period) => (
          <Box
            key={period.name}
            p={6}
            border="1px solid"
            borderColor="border.subtle"
            borderRadius="md"
            data-visual-test-no-radius
            bg="bg.default"
            shadow="sm"
          >
            <Text fontWeight="bold" fontSize="md" mb={4} color="fg.emphasized">
              {period.name}
            </Text>

            <HStack justify="space-between" mb={2}>
              <Text fontSize="sm" color="fg.default">
                Total Runs:
              </Text>
              <Text fontSize="sm" fontWeight="medium" color="fg.emphasized">
                {period.total}
              </Text>
            </HStack>

            <HStack justify="space-between" mb={2}>
              <Text fontSize="sm" color="fg.default">
                Errors:
              </Text>
              <Text fontSize="sm" fontWeight="medium" color={period.errorCount > 0 ? "red.600" : "green.600"}>
                {period.errorCount}
              </Text>
            </HStack>

            <HStack justify="space-between" mb={2}>
              <Text fontSize="sm" color="fg.default">
                Avg Queue Time:
              </Text>
              <Text
                fontSize="sm"
                fontWeight="medium"
                color={period.avgQueue > 300 ? "red.600" : period.avgQueue > 60 ? "orange.600" : "green.600"}
              >
                {formatTime(period.avgQueue)}
              </Text>
            </HStack>

            <HStack justify="space-between">
              <Text fontSize="sm" color="fg.default">
                Avg Run Time:
              </Text>
              <Text
                fontSize="sm"
                fontWeight="medium"
                color={period.avgRun > 600 ? "red.600" : period.avgRun > 120 ? "orange.600" : "green.600"}
              >
                {formatTime(period.avgRun)}
              </Text>
            </HStack>

            {/* Error Rate Indicator */}
            {period.total > 0 && (
              <Box mt={3} pt={3} borderTop="1px solid" borderColor="border.subtle">
                <HStack justify="space-between">
                  <Text fontSize="xs" color="fg.muted">
                    Error Rate:
                  </Text>
                  <Text
                    fontSize="xs"
                    fontWeight="medium"
                    color={
                      period.errorCount / period.total > 0.1
                        ? "red.600"
                        : period.errorCount / period.total > 0.05
                          ? "orange.600"
                          : "green.600"
                    }
                  >
                    {((period.errorCount / period.total) * 100).toFixed(1)}%
                  </Text>
                </HStack>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
