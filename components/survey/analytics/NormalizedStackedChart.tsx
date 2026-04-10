"use client";

import { Box, Text, VStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import { useMemo } from "react";
import type { QuestionStats } from "@/types/survey-analytics";
import { getLikertColor } from "./likert-chart-utils";

type NormalizedStackedChartProps = {
  questions: { name: string; title: string }[];
  questionStats: Record<string, QuestionStats>;
  valueLabelsByQuestion?: Record<string, Record<number, string>>;
};

export function NormalizedStackedChart({
  questions,
  questionStats,
  valueLabelsByQuestion = {}
}: NormalizedStackedChartProps) {
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

  const chartData = useMemo(() => {
    return questions
      .filter((q) => questionStats[q.name]?.distribution && Object.keys(questionStats[q.name].distribution).length > 0)
      .map((q) => {
        const dist = questionStats[q.name].distribution;
        const total = Object.values(dist).reduce((a, b) => a + b, 0);
        const segments = allValues.map((v) => ({
          valueKey: `v${v}`,
          value: total > 0 ? ((dist[v] ?? 0) / total) * 100 : 0,
          rawValue: v,
          count: dist[v] ?? 0
        }));
        return {
          name: q.title,
          qName: q.name,
          total,
          ...Object.fromEntries(segments.map((s) => [s.valueKey, s.value])),
          _segments: segments
        };
      });
  }, [questions, questionStats, allValues]);

  const barKeys = allValues.map((v) => `v${v}`);

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
      <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
        Variant 6: Normalized stacked bar (100%)
      </Text>
      <Box w="100%" h={Math.max(200, chartData.length * 36)}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ left: 4, right: 20, top: 4, bottom: 4 }}
            barCategoryGap="12%"
          >
            <XAxis type="number" domain={[0, 100]} tick={{ fill: tickColor, fontSize: 10 }} unit="%" />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fill: tickColor, fontSize: 10 }}
              width={180}
              tickFormatter={(v) => (v.length > 45 ? v.slice(0, 42) + "..." : v)}
            />
            <Tooltip
              contentStyle={{ backgroundColor: tooltipBg, borderRadius: "8px" }}
              content={({ payload }) => {
                if (!payload?.[0]?.payload?._segments) return null;
                const p = payload[0].payload;
                const labels = valueLabelsByQuestion[p.qName] ?? {};
                const segs = (p._segments as { value: number; rawValue: number; count: number }[]).filter(
                  (s) => s.count > 0
                );
                return (
                  <Box p={2} bg={tooltipBg} borderRadius="md" boxShadow="md">
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      n = {p.total}
                    </Text>
                    {segs.map((s) => (
                      <Text key={s.rawValue} fontSize="sm">
                        {labels[s.rawValue] ?? s.rawValue}: {s.count} ({s.value.toFixed(1)}%)
                      </Text>
                    ))}
                  </Box>
                );
              }}
            />
            {barKeys.map((key, idx) => {
              const rawVal = allValues[idx] ?? 0;
              const color = getLikertColor(rawVal, allValues);
              return <Bar key={key} dataKey={key} stackId="stack" fill={color} radius={0} />;
            })}
          </BarChart>
        </ResponsiveContainer>
      </Box>
    </VStack>
  );
}
