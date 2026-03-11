"use client";

import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, Cell, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { useMemo } from "react";
import type { QuestionStats } from "@/types/survey-analytics";
import { WrappedYAxisTick } from "./ChartAxisTick";
import { getDivergingColor, partitionForDiverging } from "./likert-chart-utils";

type SeriesItem = {
  surveyId: string;
  surveyLabel: string;
  surveyColor: string;
  questionStats: Record<string, QuestionStats>;
  valueLabelsByQuestion: Record<string, Record<number, string>>;
};

type DivergingStackedChartMultiSeriesProps = {
  questions: { name: string; title: string }[];
  series: SeriesItem[];
};

function buildDivergingRow(
  q: { name: string; title: string },
  questionStats: Record<string, QuestionStats>,
  valueLabelsByQuestion: Record<string, Record<number, string>>,
  allValues: number[]
) {
  const { left, neutral, right } = partitionForDiverging(allValues);
  const dist = questionStats[q.name]?.distribution;
  if (!dist || Object.keys(dist).length === 0) return null;

  const labels = valueLabelsByQuestion[q.name] ?? {};
  const row: Record<string, number | string | unknown> = {
    name: q.title,
    qName: q.name,
    _segments: [] as { valueKey: string; value: number; rawValue: number; label: string }[]
  };

  [...left]
    .sort((a, b) => b - a)
    .forEach((v) => {
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
  [...right]
    .sort((a, b) => a - b)
    .forEach((v) => {
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
}

export function DivergingStackedChartMultiSeries({ questions, series }: DivergingStackedChartMultiSeriesProps) {
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");
  const tooltipBg = useColorModeValue("#FFFFFF", "#1A1A1A");

  const allValues = useMemo(() => {
    const vals = new Set<number>();
    for (const s of series) {
      for (const q of questions) {
        const dist = s.questionStats[q.name]?.distribution;
        if (dist) Object.keys(dist).forEach((k) => vals.add(Number(k)));
      }
    }
    return Array.from(vals).sort((a, b) => a - b);
  }, [questions, series]);

  const { left, neutral, right } = useMemo(() => partitionForDiverging(allValues), [allValues]);

  const chartData = useMemo(() => {
    const rows: (Record<string, number | string | unknown> & { _surveyIndex?: number })[] = [];
    series.forEach((s, surveyIndex) => {
      questions.forEach((q) => {
        const row = buildDivergingRow(q, s.questionStats, s.valueLabelsByQuestion, allValues);
        if (row) {
          (row as Record<string, unknown>)._surveyIndex = surveyIndex;
          (row as Record<string, unknown>)._surveyLabel = s.surveyLabel;
          rows.push(row as Record<string, number | string | unknown> & { _surveyIndex?: number });
        }
      });
    });
    return rows;
  }, [questions, series, allValues]);

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
    const labels = (series[0]?.valueLabelsByQuestion ?? {})[questions[0]?.name ?? ""] ?? {};
    return allValues.map((v) => ({
      value: labels[v] ?? String(v),
      type: "square" as const,
      color: getDivergingColor(v, allValues)
    }));
  }, [allValues, questions, series]);

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

  const chartDataWithBg = useMemo(() => {
    return chartData.map((row) => ({
      ...row,
      _leftBg: -maxExtent,
      _rightBg: maxExtent
    }));
  }, [chartData, maxExtent]);

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
      <HStack gap={3} flexWrap="wrap" mb={2}>
        {series.map((s) => (
          <HStack key={s.surveyId} gap={1} fontSize="xs">
            <Box w="3" h="3" borderRadius="sm" bg={s.surveyColor} borderWidth="1px" borderColor="border" />
            <Text color="fg.muted">{s.surveyLabel}</Text>
          </HStack>
        ))}
      </HStack>
      <Box w="100%" h={Math.max(200, chartData.length * 52)}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartDataWithBg}
            layout="vertical"
            margin={{ left: labelWidth, right: 20, top: 8, bottom: 24 }}
            barCategoryGap="8%"
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
              tick={(props) => {
                const row = chartDataWithBg[props.index ?? 0];
                const suffix = (row as { _surveyLabel?: string })?._surveyLabel;
                return <WrappedYAxisTick {...props} width={labelWidth} fill={tickColor} suffix={suffix} />;
              }}
              width={labelWidth}
            />
            <Tooltip
              contentStyle={{ backgroundColor: tooltipBg, borderRadius: "8px" }}
              cursor={{ fill: "rgba(0,0,0,0.05)" }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload as
                  | {
                      _surveyLabel?: string;
                      _segments?: { valueKey: string; value: number; rawValue: number; label: string }[];
                    }
                  | undefined;
                if (!p?._segments) return null;
                const segs = p._segments;
                const byValue = new Map<number, number>();
                segs.forEach((s) => {
                  const v = s.rawValue;
                  const absVal = Math.abs(s.value);
                  byValue.set(v, (byValue.get(v) ?? 0) + absVal);
                });
                const total = Array.from(byValue.values()).reduce((a, b) => a + b, 0);
                return (
                  <Box p={2} bg={tooltipBg} borderRadius="md" boxShadow="md" minW="140px">
                    {p._surveyLabel && (
                      <Text fontSize="xs" color="fg.muted" mb={1}>
                        {p._surveyLabel}
                      </Text>
                    )}
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
            <Bar dataKey="_leftBg" stackId="stack" fill="transparent" radius={0} isAnimationActive={false}>
              {chartDataWithBg.map((entry, idx) => {
                const color =
                  series[(entry as { _surveyIndex?: number })._surveyIndex ?? 0]?.surveyColor ?? "transparent";
                return <Cell key={idx} fill={color} fillOpacity={0.2} />;
              })}
            </Bar>
            <Bar dataKey="_rightBg" stackId="stack" fill="transparent" radius={0} isAnimationActive={false}>
              {chartDataWithBg.map((entry, idx) => {
                const color =
                  series[(entry as { _surveyIndex?: number })._surveyIndex ?? 0]?.surveyColor ?? "transparent";
                return <Cell key={idx} fill={color} fillOpacity={0.2} />;
              })}
            </Bar>
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
