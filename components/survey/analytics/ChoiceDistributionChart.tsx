"use client";

import { Box, Text } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import { useMemo } from "react";
import { WrappedYAxisTick } from "./ChartAxisTick";
import type { QuestionStats } from "@/types/survey-analytics";

type ChoiceDistributionChartProps = {
  questions: { name: string; title: string }[];
  questionStats: Record<string, QuestionStats>;
  valueLabelsByQuestion?: Record<string, Record<number, string>>;
  /** Per-question, per-value: student names who gave that response (for group view tooltips) */
  namesByValueByQuestion?: Record<string, Record<number, string[]>>;
};

export function ChoiceDistributionChart({
  questions,
  questionStats,
  valueLabelsByQuestion = {},
  namesByValueByQuestion
}: ChoiceDistributionChartProps) {
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");
  const tooltipBg = useColorModeValue("#FFFFFF", "#1A1A1A");
  const barColor = useColorModeValue("#3182CE", "#63B3ED");

  const chartData = useMemo(() => {
    const rows: { name: string; count: number; qName: string; choiceValue: number }[] = [];
    for (const q of questions) {
      const dist = questionStats[q.name]?.distribution;
      const labels = valueLabelsByQuestion[q.name] ?? {};
      if (!dist || Object.keys(dist).length === 0) continue;
      const sortedValues = Object.keys(dist)
        .map(Number)
        .sort((a, b) => a - b);
      for (const v of sortedValues) {
        const count = dist[v] ?? 0;
        const label = labels[v] ?? String(v);
        rows.push({
          name: label,
          count,
          qName: q.name,
          choiceValue: v
        });
      }
    }
    return rows;
  }, [questions, questionStats, valueLabelsByQuestion]);

  const labelWidth = 280;

  if (chartData.length === 0) {
    return (
      <Box p={4} bg="bg.subtle" borderRadius="md">
        <Text color="fg.muted" fontSize="sm">
          No selection data
        </Text>
      </Box>
    );
  }

  return (
    <Box w="100%" h={Math.max(150, chartData.length * 60)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ left: labelWidth, right: 20, top: 4, bottom: 24 }}
          barCategoryGap="8%"
        >
          <XAxis
            type="number"
            tick={{ fill: tickColor, fontSize: 10 }}
            allowDecimals={false}
            label={{
              value: "Selections",
              position: "insideBottom",
              offset: -8,
              fill: tickColor,
              fontSize: 11
            }}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={<WrappedYAxisTick width={labelWidth} fill={tickColor} />}
            width={labelWidth}
          />
          <Tooltip
            contentStyle={{ backgroundColor: tooltipBg, borderRadius: "8px" }}
            cursor={{ fill: "rgba(0,0,0,0.05)" }}
            content={({ payload }) => {
              if (!payload?.[0]?.payload) return null;
              const row = payload[0].payload as { qName?: string; choiceValue?: number; count?: number; name?: string };
              const names =
                row.qName && row.choiceValue != null && namesByValueByQuestion?.[row.qName]?.[row.choiceValue];
              return (
                <Box p={2} bg={tooltipBg} borderRadius="md" boxShadow="md" minW="140px">
                  <Text fontSize="sm">
                    {row.name ?? row.choiceValue}: {row.count ?? payload[0].value} selection
                    {(row.count ?? payload[0].value) !== 1 ? "s" : ""}
                  </Text>
                  {names && names.length > 0 && (
                    <Text fontSize="xs" color="fg.muted" mt={1} whiteSpace="pre-wrap">
                      {names.join(", ")}
                    </Text>
                  )}
                </Box>
              );
            }}
          />
          <Bar dataKey="count" fill={barColor} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}
