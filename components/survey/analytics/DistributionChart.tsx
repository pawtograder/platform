"use client";

import { Box, Text, VStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import { useMemo } from "react";
import type { QuestionStats } from "@/types/survey-analytics";

type DistributionChartProps = {
  stats: QuestionStats | null;
  questionTitle: string;
  valueLabels?: Record<number, string>;
  /** Class/course average to show as reference line */
  courseMean?: number;
};

export function DistributionChart({ stats, questionTitle, valueLabels = {}, courseMean }: DistributionChartProps) {
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");
  const tooltipBg = useColorModeValue("#FFFFFF", "#1A1A1A");

  const chartData = useMemo(() => {
    if (!stats || Object.keys(stats.distribution).length === 0) return [];
    return Object.entries(stats.distribution)
      .map(([value, count]) => ({
        name: valueLabels[Number(value)] ?? String(value),
        value: count,
        rawValue: Number(value)
      }))
      .sort((a, b) => a.rawValue - b.rawValue);
  }, [stats, valueLabels]);

  const xAxisMax = useMemo(() => {
    if (chartData.length === 0) return 10;
    const maxValue = Math.max(...chartData.map((d) => d.value));
    if (maxValue === 0) return 10;
    return Math.ceil(maxValue * 1.2);
  }, [chartData]);

  if (!stats || chartData.length === 0) {
    return (
      <Box p={4} bg="bg.subtle" borderRadius="md">
        <Text color="fg.muted" fontSize="sm">
          No distribution data for this question
        </Text>
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={2} w="100%">
      <Text fontSize="sm" fontWeight="medium" color="fg.muted">
        {questionTitle}
      </Text>
      {Object.keys(valueLabels).length > 0 && (
        <Text fontSize="xs" color="fg.muted" whiteSpace="pre-wrap">
          {Object.entries(valueLabels)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([v, t]) => `${v} = ${t}`)
            .join("  ·  ")}
        </Text>
      )}
      <Box w="100%" h="240px">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 20, top: 0, bottom: 0 }}>
            <XAxis
              type="number"
              tick={{ fill: tickColor, fontSize: 10 }}
              domain={[0, xAxisMax]}
              allowDecimals={false}
            />
            <YAxis type="category" dataKey="name" tick={{ fill: tickColor, fontSize: 11 }} width={80} />
            <Tooltip
              contentStyle={{ backgroundColor: tooltipBg, borderRadius: "8px" }}
              formatter={(value: number) => [value, "Responses"]}
              labelFormatter={(label) => `Value: ${label}`}
            />
            <Bar dataKey="value" fill="#3B82F6" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Box>
      {courseMean != null && (
        <Text fontSize="xs" color="fg.muted">
          Class avg: {valueLabels[Math.round(courseMean)] ?? courseMean.toFixed(2)}
        </Text>
      )}
    </VStack>
  );
}
