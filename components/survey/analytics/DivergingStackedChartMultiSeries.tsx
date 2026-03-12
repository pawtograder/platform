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
  /** Course mean per question (for section/group view reference marker) */
  courseMeanByQuestion?: Record<string, number>;
};

function buildDivergingRow(
  q: { name: string; title: string },
  questionStats: Record<string, QuestionStats>,
  valueLabelsByQuestion: Record<string, Record<number, string>>,
  allValues: number[],
  scaleMin: number,
  scaleMax: number
) {
  const { left, neutral, right } = partitionForDiverging(allValues, scaleMin, scaleMax);
  const dist = questionStats[q.name]?.distribution;
  if (!dist || Object.keys(dist).length === 0) return null;

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

export function DivergingStackedChartMultiSeries({
  questions,
  series,
  courseMeanByQuestion
}: DivergingStackedChartMultiSeriesProps) {
  const tickColor = useColorModeValue("#1A202C", "#FFFFFF");
  const tooltipBg = useColorModeValue("#FFFFFF", "#1A1A1A");
  const borderColor = useColorModeValue("gray.200", "gray.700");

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

  const scaleMin = allValues.length > 0 ? (allValues[0] as number) : 0;
  const scaleMax = allValues.length > 0 ? (allValues[allValues.length - 1] as number) : 0;

  const { left, neutral, right } = useMemo(
    () => partitionForDiverging(allValues, scaleMin, scaleMax),
    [allValues, scaleMin, scaleMax]
  );

  const chartData = useMemo(() => {
    const rows: (Record<string, number | string | unknown> & { _surveyIndex?: number })[] = [];
    series.forEach((s, surveyIndex) => {
      questions.forEach((q) => {
        const row = buildDivergingRow(q, s.questionStats, s.valueLabelsByQuestion, allValues, scaleMin, scaleMax);
        if (row) {
          (row as Record<string, unknown>)._surveyIndex = surveyIndex;
          (row as Record<string, unknown>)._surveyLabel = s.surveyLabel;
          rows.push(row as Record<string, number | string | unknown> & { _surveyIndex?: number });
        }
      });
    });
    return rows;
  }, [questions, series, allValues, scaleMin, scaleMax]);

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
    const labels = (series[0]?.valueLabelsByQuestion ?? {})[questions[0]?.name ?? ""] ?? {};
    return allValues.map((v) => ({
      value: labels[v] ?? String(v),
      type: "square" as const,
      color: getDivergingColor(v, allValues, scaleMin, scaleMax)
    }));
  }, [allValues, questions, series, scaleMin, scaleMax]);

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

  const chartDataBySeries = useMemo(() => {
    const groups: (Record<string, number | string | unknown> & { _surveyIndex?: number; _surveyLabel?: string })[][] =
      [];
    series.forEach((_, surveyIndex) => {
      const rows = chartData.filter((r) => (r as { _surveyIndex?: number })._surveyIndex === surveyIndex);
      if (rows.length > 0) groups.push(rows);
    });
    return groups;
  }, [chartData, series]);

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
    <VStack align="stretch" gap={4} w="100%">
      <HStack gap={3} flexWrap="wrap" mb={2}>
        {series.map((s) => (
          <HStack key={s.surveyId} gap={1} fontSize="xs">
            <Box w="3" h="3" borderRadius="sm" bg={s.surveyColor} borderWidth="1px" borderColor="border" />
            <Text color="fg.muted">{s.surveyLabel}</Text>
          </HStack>
        ))}
      </HStack>
      {chartDataBySeries.map((groupData, groupIdx) => (
        <Box
          key={groupIdx}
          borderWidth="1px"
          borderColor={borderColor}
          borderRadius="md"
          p={3}
          borderLeftWidth="4px"
          borderLeftColor={series[groupIdx]?.surveyColor ?? "gray"}
        >
          <Text fontSize="xs" color="fg.muted" mb={2}>
            {series[groupIdx]?.surveyLabel}
          </Text>
          <Box w="100%" h={Math.max(200, groupData.length * 52)}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={groupData}
                layout="vertical"
                margin={{ left: labelWidth, right: 20, top: 8, bottom: 40 }}
                barCategoryGap="8%"
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
                    const p = payload?.[0]?.payload as
                      | {
                          qName?: string;
                          _surveyLabel?: string;
                          _segments?: { valueKey: string; value: number; rawValue: number; label: string }[];
                        }
                      | undefined;
                    if (!p?._segments) return null;
                    const segs = p._segments;
                    const qName = p.qName;
                    const byValue = new Map<number, number>();
                    segs.forEach((s) => {
                      const v = s.rawValue;
                      const absVal = Math.abs(s.value);
                      byValue.set(v, (byValue.get(v) ?? 0) + absVal);
                    });
                    const total = Array.from(byValue.values()).reduce((a, b) => a + b, 0);
                    const seriesStats = series[groupIdx]?.questionStats;
                    const groupMean = qName ? seriesStats?.[qName]?.mean : undefined;
                    const courseMean = qName ? courseMeanByQuestion?.[qName] : undefined;
                    const arrowType =
                      typeof groupMean === "number" && typeof courseMean === "number"
                        ? getComparisonArrowType(groupMean, courseMean)
                        : null;
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
                    <Bar
                      key={key}
                      dataKey={key}
                      stackId="stack"
                      fill={getDivergingColor(rawVal, allValues, scaleMin, scaleMax)}
                      radius={0}
                    />
                  );
                })}
                {rightKeys.map((key) => {
                  const match = key.match(/right_v(\d+)|right_neutral_(\d+)/);
                  const rawVal = match ? Number(match[1] ?? match[2]) : 0;
                  return (
                    <Bar
                      key={key}
                      dataKey={key}
                      stackId="stack"
                      fill={getDivergingColor(rawVal, allValues, scaleMin, scaleMax)}
                      radius={0}
                    />
                  );
                })}
                {courseMeanByQuestion &&
                  allValues.length > 0 &&
                  groupData.map((row) => {
                    const qName = (row as { qName?: string }).qName;
                    const courseMean = qName && courseMeanByQuestion[qName];
                    if (courseMean == null || typeof courseMean !== "number") return null;
                    const seriesStats = series[groupIdx]?.questionStats;
                    const groupMean = qName && seriesStats?.[qName]?.mean;
                    if (groupMean == null || typeof groupMean !== "number") return null;
                    const arrowType = getComparisonArrowType(groupMean, courseMean);
                    if (!arrowType) return null;
                    const min = allValues[0] as number;
                    const max = allValues[allValues.length - 1] as number;
                    const valueExtent = max - min || 1;
                    const valueScale = (v: number) => ((v - min) / valueExtent) * 2 - 1;
                    const x = valueScale(courseMean) * valueExtent;
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
            <HStack gap={4} flexWrap="wrap" justify="center" pt={2} fontSize={10}>
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
        </Box>
      ))}
    </VStack>
  );
}
