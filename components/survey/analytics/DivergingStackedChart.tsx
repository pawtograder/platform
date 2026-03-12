"use client";

import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, ReferenceDot, ReferenceLine } from "recharts";
import { useMemo } from "react";
import type { QuestionStats } from "@/types/survey-analytics";
import { WrappedYAxisTick } from "./ChartAxisTick";
import { getDivergingColor, getComparisonArrowType, partitionForDiverging, LIKERT_COLORS } from "./likert-chart-utils";
import type { ComparisonArrowType } from "./likert-chart-utils";

const ARROW_SIZE = 6;
const upPath = `M 0 -${ARROW_SIZE} L ${ARROW_SIZE} ${ARROW_SIZE} L -${ARROW_SIZE} ${ARROW_SIZE} Z`;
const downPath = `M -${ARROW_SIZE} -${ARROW_SIZE} L ${ARROW_SIZE} -${ARROW_SIZE} L 0 ${ARROW_SIZE} Z`;

function ComparisonArrowShape({
  cx = 0,
  cy = 0,
  type,
  color
}: {
  cx?: number;
  cy?: number;
  type: ComparisonArrowType;
  color: string;
}) {
  const gap = 3;
  if (type === "up" || type === "double-up") {
    return (
      <g transform={`translate(${cx}, ${cy})`} fill={color}>
        {type === "up" ? (
          <path d={upPath} />
        ) : (
          <>
            <g transform={`translate(0, -${gap})`}>
              <path d={upPath} />
            </g>
            <g transform={`translate(0, ${gap})`}>
              <path d={upPath} />
            </g>
          </>
        )}
      </g>
    );
  }
  return (
    <g transform={`translate(${cx}, ${cy})`} fill={color}>
      {type === "down" ? (
        <path d={downPath} />
      ) : (
        <>
          <g transform={`translate(0, -${gap})`}>
            <path d={downPath} />
          </g>
          <g transform={`translate(0, ${gap})`}>
            <path d={downPath} />
          </g>
        </>
      )}
    </g>
  );
}

type DivergingStackedChartProps = {
  questions: { name: string; title: string }[];
  questionStats: Record<string, QuestionStats>;
  /** Per-question value labels: questionName -> value -> label */
  valueLabelsByQuestion?: Record<string, Record<number, string>>;
  /** Per-question, per-value: student names who gave that response (for group view tooltips) */
  namesByValueByQuestion?: Record<string, Record<number, string[]>>;
  /** Course mean per question (for section/group view reference marker) */
  courseMeanByQuestion?: Record<string, number>;
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
  valueLabelsByQuestion = {},
  namesByValueByQuestion,
  courseMeanByQuestion
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
    neutral.forEach((v) => keys.push(`left_neutral_${v}`));
    [...left].sort((a, b) => b - a).forEach((v) => keys.push(`left_v${v}`));
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
            margin={{ left: labelWidth, right: 20, top: 8, bottom: 40 }}
            barCategoryGap="12%"
            stackOffset="sign"
          >
            <XAxis
              type="number"
              domain={[-maxExtent, maxExtent]}
              tick={{ fill: tickColor, fontSize: 10 }}
              allowDecimals={false}
              ticks={[-maxExtent, 0, maxExtent]}
              label={{ value: "Count", position: "insideBottom", offset: -8, fill: tickColor, fontSize: 11 }}
            />
            <ReferenceLine x={0} stroke={tickColor} strokeOpacity={0.4} strokeWidth={1} />
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
                const row = payload[0].payload as { qName?: string; _segments: unknown[] };
                const segs = row._segments as {
                  valueKey: string;
                  value: number;
                  rawValue: number;
                  label: string;
                }[];
                const qName = row.qName;
                const namesByValue = qName && namesByValueByQuestion?.[qName];
                const byValue = new Map<number, number>();
                segs.forEach((s) => {
                  const v = s.rawValue;
                  const absVal = Math.abs(s.value);
                  byValue.set(v, (byValue.get(v) ?? 0) + absVal);
                });
                const total = Array.from(byValue.values()).reduce((a, b) => a + b, 0);
                const groupMean = qName ? questionStats[qName]?.mean : undefined;
                const courseMean = qName ? courseMeanByQuestion?.[qName] : undefined;
                const arrowType =
                  typeof groupMean === "number" && typeof courseMean === "number"
                    ? getComparisonArrowType(groupMean, courseMean)
                    : null;
                return (
                  <Box p={2} bg={tooltipBg} borderRadius="md" boxShadow="md" minW="140px">
                    {Array.from(byValue.entries())
                      .sort(([a], [b]) => a - b)
                      .filter(([, c]) => c > 0)
                      .map(([v, count]) => {
                        const names = namesByValue?.[v];
                        return (
                          <Box key={v} mb={names?.length ? 2 : 0}>
                            <Text fontSize="sm">
                              {segs.find((s) => s.rawValue === v)?.label ?? v}: {count}
                              {total > 0 ? ` (${((100 * count) / total).toFixed(0)}%)` : ""}
                            </Text>
                            {names && Array.isArray(names) && names.length > 0 && (
                              <Text fontSize="xs" color="fg.muted" mt={1} whiteSpace="pre-wrap">
                                {names.join(", ")}
                              </Text>
                            )}
                          </Box>
                        );
                      })}
                    {typeof groupMean === "number" && typeof courseMean === "number" && (
                      <Box mt={2} pt={2} borderTopWidth="1px" borderColor="border" fontSize="xs" color="fg.muted">
                        <Text fontWeight="medium" color="fg" mb={1}>
                          vs. course average
                        </Text>
                        <Text>Group mean: {groupMean.toFixed(2)}</Text>
                        <Text>Course mean: {courseMean.toFixed(2)}</Text>
                        <Text
                          mt={1}
                          fontWeight="medium"
                          color={
                            arrowType === "up" || arrowType === "double-up"
                              ? LIKERT_COLORS.positive
                              : arrowType === "down" || arrowType === "double-down"
                                ? LIKERT_COLORS.negative
                                : "fg.muted"
                          }
                        >
                          {arrowType === "up"
                            ? "Group above class"
                            : arrowType === "double-up"
                              ? "Group well above class"
                              : arrowType === "down"
                                ? "Group below class"
                                : arrowType === "double-down"
                                  ? "Group well below class"
                                  : "About the same"}
                        </Text>
                      </Box>
                    )}
                  </Box>
                );
              }}
            />
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
            {chartData.map((row) => {
              const qName = (row as { qName?: string }).qName;
              const courseMean = qName && courseMeanByQuestion?.[qName];
              if (courseMean == null || allValues.length === 0 || typeof courseMean !== "number") return null;
              const groupMean = qName ? questionStats[qName]?.mean : undefined;
              if (groupMean == null || typeof groupMean !== "number") return null;
              const arrowType = getComparisonArrowType(groupMean, courseMean);
              if (!arrowType) return null;
              const min = allValues[0] as number;
              const max = allValues[allValues.length - 1] as number;
              const range = max - min || 1;
              const normalizedMean = (courseMean - min) / range;
              const x = (2 * normalizedMean - 1) * maxExtent;
              const color =
                arrowType === "up" || arrowType === "double-up" ? LIKERT_COLORS.positive : LIKERT_COLORS.negative;
              return (
                <ReferenceDot
                  key={`mean-${qName}`}
                  x={x}
                  y={(row as { name: string }).name}
                  r={8}
                  shape={(props: { cx?: number; cy?: number }) => (
                    <ComparisonArrowShape {...props} type={arrowType} color={color} />
                  )}
                />
              );
            })}
          </BarChart>
        </ResponsiveContainer>
      </Box>
      <Box pl={labelWidth} pr={20} w="100%">
        <HStack gap={4} flexWrap="wrap" justify="center" pt={0} fontSize={10}>
          {legendPayload.map((item) => (
            <HStack key={item.value} gap={1.5}>
              <Box w="3" h="3" flexShrink={0} bg={item.color} borderRadius="sm" />
              <Text color="fg.muted">{item.value}</Text>
            </HStack>
          ))}
          {courseMeanByQuestion && Object.keys(courseMeanByQuestion).length > 0 && (
            <>
              <HStack gap={1.5} ml={2} pl={2} borderLeftWidth="1px" borderColor="border">
                <Box w="3" h="3" flexShrink={0} bg={LIKERT_COLORS.positive} borderRadius="sm" />
                <Text color="fg.muted">above class</Text>
              </HStack>
              <HStack gap={1.5}>
                <Box w="3" h="3" flexShrink={0} bg={LIKERT_COLORS.negative} borderRadius="sm" />
                <Text color="fg.muted">below class</Text>
              </HStack>
            </>
          )}
        </HStack>
      </Box>
    </VStack>
  );
}
