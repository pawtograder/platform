"use client";

import { Box, Text, VStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { ComposedChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Scatter } from "recharts";
import { useMemo } from "react";
import type { QuestionStats } from "@/types/survey-analytics";
import { getLikertColor } from "./likert-chart-utils";

type MeanDotStripChartProps = {
  questions: { name: string; title: string }[];
  questionStats: Record<string, QuestionStats>;
  courseMeans?: Record<string, number>;
  valueLabelsByQuestion?: Record<string, Record<number, string>>;
};

export function MeanDotStripChart({
  questions,
  questionStats,
  courseMeans = {},
  valueLabelsByQuestion = {}
}: MeanDotStripChartProps) {
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
        const stats = questionStats[q.name];
        const segments = allValues.map((v) => ({
          valueKey: `v${v}`,
          value: dist[v] ?? 0,
          rawValue: v
        }));
        const total = segments.reduce((s, seg) => s + seg.value, 0);
        const mean = stats.mean;
        const floorMean = Math.floor(mean);
        const ceilMean = Math.ceil(mean);
        const frac = mean - floorMean;
        let meanPosition = 0;
        for (const v of allValues) {
          const c = dist[v] ?? 0;
          if (v < ceilMean) meanPosition += c;
          else if (v === ceilMean) {
            meanPosition += frac * c;
            break;
          }
        }
        return {
          name: q.title,
          qName: q.name,
          mean: stats.mean,
          meanPosition: total > 0 ? meanPosition : 0,
          total,
          courseMean: courseMeans[q.name],
          ...Object.fromEntries(segments.map((s) => [s.valueKey, s.value])),
          _segments: segments
        };
      });
  }, [questions, questionStats, courseMeans, allValues]);

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
        Variant 2: Mean dot + distribution strip
      </Text>
      <Box w="100%" h={Math.max(200, chartData.length * 50)}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={chartData}
            layout="vertical"
            margin={{ left: 4, right: 24, top: 4, bottom: 4 }}
            barCategoryGap="20%"
            barGap={2}
          >
            <XAxis type="number" domain={[0, "auto"]} tick={{ fill: tickColor, fontSize: 10 }} />
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
                if (!payload?.[0]?.payload) return null;
                const p = payload[0].payload;
                const labels = valueLabelsByQuestion[p.qName] ?? {};
                const segs = (p._segments as { value: number; rawValue: number }[]).filter((s) => s.value > 0);
                return (
                  <Box p={2} bg={tooltipBg} borderRadius="md" boxShadow="md">
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      Mean: {p.mean.toFixed(2)}
                      {p.courseMean != null && ` | Class avg: ${p.courseMean.toFixed(2)}`}
                    </Text>
                    {segs.map((s) => (
                      <Text key={s.rawValue} fontSize="sm">
                        {labels[s.rawValue] ?? s.rawValue}: {s.value}
                      </Text>
                    ))}
                  </Box>
                );
              }}
            />
            {barKeys.map((key, idx) => {
              const rawVal = allValues[idx] ?? 0;
              const color = getLikertColor(rawVal, allValues);
              return <Bar key={key} dataKey={key} stackId="strip" fill={color} barSize={8} radius={0} />;
            })}
            <Scatter dataKey="meanPosition" fill="#1A202C" shape="circle" r={5} />
          </ComposedChart>
        </ResponsiveContainer>
      </Box>
    </VStack>
  );
}
