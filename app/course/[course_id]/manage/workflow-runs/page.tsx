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

        // Define time periods with their duration in hours
        const timePeriods = [
          { name: "Last 30 minutes", hours: 0.5 },
          { name: "Last hour", hours: 1 },
          { name: "Today", hours: 24 },
          { name: "This week", hours: 24 * 7 },
          { name: "This month", hours: 24 * 30 },
          { name: "All time", hours: 24 * 30 * 6 } // 6 months max retention
        ];

        const statsData = await Promise.all(
          timePeriods.map(async (period) => {
            // Call the RPC function to get workflow statistics
            const { data: rpcData, error: rpcError } = await client.rpc("get_workflow_statistics", {
              p_class_id: Number(course_id),
              p_duration_hours: Math.floor(period.hours)
            });

            if (rpcError) {
              console.error(`Error fetching workflow stats for ${period.name}:`, rpcError);
              return {
                name: period.name,
                total: 0,
                avgQueue: 0,
                avgRun: 0,
                errorCount: 0
              };
            }

            // The RPC returns an array with a single row, or empty array if no data
            const stats = rpcData && rpcData.length > 0 ? rpcData[0] : null;

            return {
              name: period.name,
              total: Number(stats?.total_runs || 0),
              avgQueue: Math.round(Number(stats?.avg_queue_time_seconds || 0)),
              avgRun: Math.round(Number(stats?.avg_run_time_seconds || 0)),
              errorCount: Number(stats?.error_count || 0)
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
