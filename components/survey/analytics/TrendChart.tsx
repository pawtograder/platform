"use client";

import { Box, Text, VStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { useMemo } from "react";
import type { TrendDataPoint } from "@/types/survey-analytics";

type TrendChartProps = {
  trendData: TrendDataPoint[];
  questionName: string;
  questionTitle: string;
};

const COLORS = ["#3B82F6", "#22C55E", "#F59E0B", "#EF4444", "#8B5CF6"];

export function TrendChart({ trendData, questionName, questionTitle }: TrendChartProps) {
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");
  const tooltipBg = useColorModeValue("#FFFFFF", "#1A1A1A");

  const chartData = useMemo(() => {
    const byOrdinal = new Map<
      number,
      { ordinal: number; surveyTitle: string; dueDate: string; [key: string]: unknown }
    >();

    trendData.forEach((d) => {
      if (d.questionName !== questionName) return;
      const key = d.ordinal;
      if (!byOrdinal.has(key)) {
        byOrdinal.set(key, {
          ordinal: key,
          surveyTitle: d.surveyTitle,
          dueDate: d.dueDate,
          name: `Week ${key}`
        });
      }
      const row = byOrdinal.get(key)!;
      const groupKey = d.groupName ?? "Course";
      row[groupKey] = d.mean;
    });

    return Array.from(byOrdinal.values()).sort((a, b) => a.ordinal - b.ordinal);
  }, [trendData, questionName]);

  const groupNames = useMemo(() => {
    const groups = new Set<string>();
    chartData.forEach((row) => {
      Object.keys(row).forEach((k) => {
        if (!["ordinal", "surveyTitle", "dueDate", "name"].includes(k)) {
          groups.add(k);
        }
      });
    });
    return Array.from(groups);
  }, [chartData]);

  if (chartData.length === 0) {
    return (
      <Box p={4} bg="bg.subtle" borderRadius="md">
        <Text color="fg.muted" fontSize="sm">
          No trend data for this question
        </Text>
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={2} w="100%">
      <Text fontSize="sm" fontWeight="medium" color="fg.muted">
        {questionTitle}
      </Text>
      <Box w="100%" h="280px">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" tick={{ fill: tickColor, fontSize: 10 }} tickLine={{ stroke: tickColor }} />
            <YAxis
              tick={{ fill: tickColor, fontSize: 10 }}
              tickLine={{ stroke: tickColor }}
              domain={["auto", "auto"]}
            />
            <Tooltip
              contentStyle={{ backgroundColor: tooltipBg, borderRadius: "8px" }}
              formatter={(value: number) => [value?.toFixed(2) ?? "—", "Mean"]}
            />
            <Legend />
            {groupNames.map((groupName, i) => (
              <Line
                key={groupName}
                type="monotone"
                dataKey={groupName}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={2}
                dot={{ r: 4 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Box>
    </VStack>
  );
}
