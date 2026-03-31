"use client";

import { Box, Text, VStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell } from "recharts";
import { useMemo } from "react";
import type { QuestionStats } from "@/types/survey-analytics";
import { getLikertColor, getGlobalMaxCount, truncateTitle } from "./likert-chart-utils";

type ConsistentAxesChartProps = {
  questions: { name: string; title: string }[];
  questionStats: Record<string, QuestionStats>;
  courseMeans?: Record<string, number>;
  valueLabelsByQuestion?: Record<string, Record<number, string>>;
};

export function ConsistentAxesChart({
  questions,
  questionStats,
  courseMeans = {},
  valueLabelsByQuestion = {}
}: ConsistentAxesChartProps) {
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

  const xAxisMax = useMemo(() => getGlobalMaxCount(questionStats), [questionStats]);

  const chartData = useMemo(() => {
    return questions
      .filter((q) => questionStats[q.name]?.distribution && Object.keys(questionStats[q.name].distribution).length > 0)
      .flatMap((q) => {
        const dist = questionStats[q.name].distribution;
        const stats = questionStats[q.name];
        return allValues.map((v) => ({
          questionTitle: truncateTitle(q.title, 45),
          qName: q.name,
          valueLabel: (valueLabelsByQuestion[q.name] ?? {})[v] ?? String(v),
          value: v,
          count: dist[v] ?? 0,
          mean: stats.mean,
          courseMean: courseMeans[q.name]
        }));
      });
  }, [questions, questionStats, courseMeans, allValues, valueLabelsByQuestion]);

  const dataByQuestion = useMemo(() => {
    const map = new Map<string, typeof chartData>();
    for (const row of chartData) {
      const key = row.qName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    return map;
  }, [chartData]);

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
    <VStack align="stretch" gap={6} w="100%">
      <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
        Variant 9: Consistent axes + color
      </Text>
      {Array.from(dataByQuestion.entries()).map(([qName, rows]) => {
        const first = rows[0];
        const courseMean = first?.courseMean;
        return (
          <Box key={qName} borderWidth="1px" borderColor="border" borderRadius="md" p={4}>
            <Text fontSize="sm" fontWeight="medium" color="fg.muted" mb={2}>
              {first?.questionTitle}
            </Text>
            <Box w="100%" h="200px">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ left: 0, right: 20, top: 0, bottom: 0 }} layout="vertical">
                  <XAxis
                    type="number"
                    tick={{ fill: tickColor, fontSize: 10 }}
                    domain={[0, xAxisMax]}
                    allowDecimals={false}
                  />
                  <YAxis type="category" dataKey="valueLabel" tick={{ fill: tickColor, fontSize: 11 }} width={100} />
                  <Tooltip
                    contentStyle={{ backgroundColor: tooltipBg, borderRadius: "8px" }}
                    formatter={(value: number) => [value, "Responses"]}
                    labelFormatter={(label) => `Value: ${label}`}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {rows.map((entry, idx) => (
                      <Cell key={idx} fill={getLikertColor(entry.value, allValues)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Box>
            {first && (
              <Text fontSize="xs" color="fg.muted" mt={2}>
                Mean: {first.mean.toFixed(2)}
                {courseMean != null && ` | Class avg: ${courseMean.toFixed(2)}`}
              </Text>
            )}
          </Box>
        );
      })}
    </VStack>
  );
}
