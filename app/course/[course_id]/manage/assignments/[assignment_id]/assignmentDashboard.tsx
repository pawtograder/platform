"use client";

import { useMemo } from "react";
import { Box, Heading, Spinner, Text, VStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from "@/components/ui/recharts-wrapper";
import { useTableControllerTableValues } from "@/lib/TableController";
import { useIsTableControllerReady } from "@/lib/TableController";
import TableController from "@/lib/TableController";

type AssignmentDashboardProps = {
  tableController: TableController<"submissions"> | null;
};

type ChartDataItem = {
  name: string;
  value: number;
};

export default function AssignmentDashboard({ tableController }: AssignmentDashboardProps) {
  const tickColor = useColorModeValue("black", "white");
  const tooltipBg = useColorModeValue("white", "#1A1A1A");

  // Get all rows directly from the table controller
  const rows = useTableControllerTableValues(tableController ?? undefined);
  const isReady = useIsTableControllerReady(tableController ?? undefined);
  const isLoading = !isReady;

  // Compute submission count distribution
  const submissionCountData = useMemo(() => {
    if (!tableController || isLoading) {
      return [];
    }

    if (rows.length === 0) {
      return [];
    }

    try {
      const countMap = new Map<number, number>();

      rows.forEach((row) => {
        // Type assertion: ordinal will be available after migration is applied
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const submission = row as any;
        const ordinal = submission.ordinal;
        if (ordinal !== null && ordinal !== undefined && typeof ordinal === "number") {
          countMap.set(ordinal, (countMap.get(ordinal) || 0) + 1);
        }
      });

      // Convert to chart data format, sorted by ordinal
      const chartData: ChartDataItem[] = Array.from(countMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([ordinal, count]) => ({
          name: `${ordinal} submission${ordinal !== 1 ? "s" : ""}`,
          value: count
        }));

      return chartData;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error computing submission count data:", error);
      return [];
    }
  }, [rows, tableController, isLoading]);

  // Compute autograder score distribution
  const scoreDistributionData = useMemo(() => {
    if (!tableController || isLoading) {
      return [];
    }

    if (rows.length === 0) {
      return [];
    }

    try {
      const scoreMap = new Map<number, number>();

      rows.forEach((row) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const submission = row as any;
        const score = submission.autograder_score;
        if (score !== null && score !== undefined && typeof score === "number") {
          // Round to nearest integer for bucketing
          const roundedScore = Math.round(score);
          scoreMap.set(roundedScore, (scoreMap.get(roundedScore) || 0) + 1);
        }
      });

      // Convert to chart data format, sorted by score
      const chartData: ChartDataItem[] = Array.from(scoreMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([score, count]) => ({
          name: score.toString(),
          value: count
        }));

      return chartData;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error computing score distribution data:", error);
      return [];
    }
  }, [rows, tableController, isLoading]);

  if (isLoading) {
    return <Spinner />;
  }

  return (
    <VStack align="stretch" gap={8} p={4}>
      <Box>
        <Heading size="md" mb={4}>
          Submission Count Distribution
        </Heading>
        {submissionCountData.length > 0 ? (
          <Box w="100%">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={submissionCountData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fill: tickColor }} />
                <YAxis
                  tick={{ fill: tickColor }}
                  label={{ value: "Number of Students", angle: -90, position: "insideLeft" }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: tooltipBg }}
                  formatter={(value: number) => [value, "Students"]}
                />
                <Bar dataKey="value" fill="#8884d8" />
              </BarChart>
            </ResponsiveContainer>
          </Box>
        ) : (
          <Text>No submission data available.</Text>
        )}
      </Box>
      <Box>
        <Heading size="md" mb={4}>
          Autograder Score Distribution
        </Heading>
        {scoreDistributionData.length > 0 ? (
          <Box w="100%">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={scoreDistributionData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: tickColor }}
                  label={{ value: "Score", position: "insideBottom", offset: -5 }}
                />
                <YAxis
                  tick={{ fill: tickColor }}
                  label={{ value: "Number of Students", angle: -90, position: "insideLeft" }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: tooltipBg }}
                  formatter={(value: number) => [value, "Students"]}
                />
                <Bar dataKey="value" fill="#82ca9d" />
              </BarChart>
            </ResponsiveContainer>
          </Box>
        ) : (
          <Text>No autograder score data available.</Text>
        )}
      </Box>
    </VStack>
  );
}
