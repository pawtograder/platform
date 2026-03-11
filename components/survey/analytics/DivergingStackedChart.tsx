"use client";

import { Box, Text, VStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { useMemo } from "react";
import type { QuestionStats } from "@/types/survey-analytics";
import { WrappedYAxisTick } from "./ChartAxisTick";
import { getDivergingColor, partitionForDiverging } from "./likert-chart-utils";

type DivergingStackedChartProps = {
  questions: { name: string; title: string }[];
  questionStats: Record<string, QuestionStats>;
  /** Per-question value labels: questionName -> value -> label */
  valueLabelsByQuestion?: Record<string, Record<number, string>>;
};

/** Build diverging chart data: left stack (negative), right stack (positive), neutral split at center */
function buildDivergingData(
  questions: { name: string; title: string }[],
  questionStats: Record<string, QuestionStats>,
  allValues: number[],
  valueLabelsByQuestion: Record<string, Record<number, string>>
) {
  const { left, neutral, right } = partitionForDiverging(allValues);

  const leftOrder = [...left].sort((a, b) => b - a);
  const rightOrder = [...right].sort((a, b) => a - b);

  return questions
    .filter((q) => questionStats[q.name]?.distribution && Object.keys(questionStats[q.name].distribution).length > 0)
    .map((q) => {
      const dist = questionStats[q.name].distribution;
      const labels = valueLabelsByQuestion[q.name] ?? {};

      const row: Record<string, number | string | unknown> = {
        name: q.title,
        qName: q.name,
        _segments: [] as { valueKey: string; value: number; rawValue: number; label: string }[]
      };

      leftOrder.forEach((v) => {
        const count = dist[v] ?? 0;
        const key = `left_v${v}`;
        (row as Record<string, number>)[key] = -count;
        (row._segments as { valueKey: string; value: number; rawValue: number; label: string }[]).push({
          valueKey: key,
          value: -count,
          rawValue: v,
          label: labels[v] ?? String(v)
        });
      });

      neutral.forEach((v) => {
        const count = dist[v] ?? 0;
        const half = count / 2;
        (row as Record<string, number>)[`left_neutral_${v}`] = -half;
        (row as Record<string, number>)[`right_neutral_${v}`] = half;
        (row._segments as { valueKey: string; value: number; rawValue: number; label: string }[]).push(
          { valueKey: `left_neutral_${v}`, value: -half, rawValue: v, label: labels[v] ?? String(v) },
          { valueKey: `right_neutral_${v}`, value: half, rawValue: v, label: labels[v] ?? String(v) }
        );
      });

      rightOrder.forEach((v) => {
        const count = dist[v] ?? 0;
        const key = `right_v${v}`;
        (row as Record<string, number>)[key] = count;
        (row._segments as { valueKey: string; value: number; rawValue: number; label: string }[]).push({
          valueKey: key,
          value: count,
          rawValue: v,
          label: labels[v] ?? String(v)
        });
      });

      return row;
    });
}

export function DivergingStackedChart({
  questions,
  questionStats,
  valueLabelsByQuestion = {}
}: DivergingStackedChartProps) {
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");
  const tooltipBg = useColorModeValue("#FFFFFF", "#1A1A1A");

  const allValues = useMemo(() => {
    const vals = new Set<number>();
    for (const q of questions) {
      const dist = questionStats[q.name]?.distribution;
      if (dist) Object.keys(dist).forEach((k) => vals.add(Number(k)));
    }
    return Array.from(vals).sort((a, b) => a - b);
  }, [questions, questionStats]);

  const { left, neutral, right } = useMemo(() => partitionForDiverging(allValues), [allValues]);

  const chartData = useMemo(
    () => buildDivergingData(questions, questionStats, allValues, valueLabelsByQuestion),
    [questions, questionStats, allValues, valueLabelsByQuestion]
  );

  const leftKeys = useMemo(() => {
    const keys: string[] = [];
    [...left].sort((a, b) => b - a).forEach((v) => keys.push(`left_v${v}`));
    neutral.forEach((v) => keys.push(`left_neutral_${v}`));
    return keys;
  }, [left, neutral]);

  const rightKeys = useMemo(() => {
    const keys: string[] = [];
    neutral.forEach((v) => keys.push(`right_neutral_${v}`));
    [...right].sort((a, b) => a - b).forEach((v) => keys.push(`right_v${v}`));
    return keys;
  }, [right, neutral]);

  const legendPayload = useMemo(() => {
    const labels = valueLabelsByQuestion[questions[0]?.name ?? ""] ?? {};
    return allValues.map((v) => ({
      value: labels[v] ?? String(v),
      type: "square" as const,
      color: getDivergingColor(v, allValues)
    }));
  }, [allValues, valueLabelsByQuestion, questions]);

  const maxExtent = useMemo(() => {
    let max = 0;
    for (const row of chartData) {
      let leftSum = 0;
      let rightSum = 0;
      for (const k of leftKeys) leftSum += Math.abs((row[k] as number) ?? 0);
      for (const k of rightKeys) rightSum += (row[k] as number) ?? 0;
      max = Math.max(max, leftSum, rightSum);
    }
    return Math.ceil(max * 1.1) || 10;
  }, [chartData, leftKeys, rightKeys]);

  const labelWidth = 280;

  if (chartData.length === 0) {
    return (
      <Box p={4} bg="bg.subtle" borderRadius="md">
        <Text color="fg.muted" fontSize="sm">
          No distribution data
        </Text>
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={2} w="100%">
      <Box w="100%" h={Math.max(200, chartData.length * 52)}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ left: labelWidth, right: 20, top: 8, bottom: 24 }}
            barCategoryGap="12%"
            stackOffset="sign"
          >
            <XAxis
              type="number"
              domain={[-maxExtent, maxExtent]}
              tick={{ fill: tickColor, fontSize: 10 }}
              allowDecimals={false}
              label={{ value: "Count", position: "insideBottom", offset: -8, fill: tickColor, fontSize: 11 }}
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
                if (!payload?.[0]?.payload?._segments) return null;
                const segs = payload[0].payload._segments as {
                  valueKey: string;
                  value: number;
                  rawValue: number;
                  label: string;
                }[];
                const byValue = new Map<number, number>();
                segs.forEach((s) => {
                  const v = s.rawValue;
                  const absVal = Math.abs(s.value);
                  byValue.set(v, (byValue.get(v) ?? 0) + absVal);
                });
                const total = Array.from(byValue.values()).reduce((a, b) => a + b, 0);
                return (
                  <Box p={2} bg={tooltipBg} borderRadius="md" boxShadow="md" minW="140px">
                    {Array.from(byValue.entries())
                      .sort(([a], [b]) => a - b)
                      .filter(([, c]) => c > 0)
                      .map(([v, count]) => (
                        <Text key={v} fontSize="sm">
                          {segs.find((s) => s.rawValue === v)?.label ?? v}: {count}
                          {total > 0 ? ` (${((100 * count) / total).toFixed(0)}%)` : ""}
                        </Text>
                      ))}
                  </Box>
                );
              }}
            />
            <Legend payload={legendPayload} wrapperStyle={{ fontSize: 10 }} />
            {leftKeys.map((key) => {
              const match = key.match(/left_v(\d+)|left_neutral_(\d+)/);
              const rawVal = match ? Number(match[1] ?? match[2]) : 0;
              return (
                <Bar key={key} dataKey={key} stackId="stack" fill={getDivergingColor(rawVal, allValues)} radius={0} />
              );
            })}
            {rightKeys.map((key) => {
              const match = key.match(/right_v(\d+)|right_neutral_(\d+)/);
              const rawVal = match ? Number(match[1] ?? match[2]) : 0;
              return (
                <Bar key={key} dataKey={key} stackId="stack" fill={getDivergingColor(rawVal, allValues)} radius={0} />
              );
            })}
          </BarChart>
        </ResponsiveContainer>
      </Box>
    </VStack>
  );
}
