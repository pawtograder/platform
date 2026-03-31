"use client";

import { Box, Table, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";
import type { QuestionStats } from "@/types/survey-analytics";

type LikertHeatmapProps = {
  questions: { name: string; title: string }[];
  questionStats: Record<string, QuestionStats>;
  valueLabelsByQuestion?: Record<string, Record<number, string>>;
};

/** Interpolate color from count to max (gray -> blue intensity) */
function getHeatColor(count: number, maxCount: number): string {
  if (maxCount === 0) return "rgba(148, 163, 184, 0.2)";
  const intensity = Math.min(1, count / maxCount);
  const r = Math.round(59 + (37 - 59) * intensity);
  const g = Math.round(130 + (99 - 130) * intensity);
  const b = Math.round(246 + (237 - 246) * intensity);
  const a = 0.3 + 0.7 * intensity;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function LikertHeatmap({ questions, questionStats }: LikertHeatmapProps) {
  const { allValues, rows, maxCount } = useMemo(() => {
    const vals = new Set<number>();
    for (const q of questions) {
      const dist = questionStats[q.name]?.distribution;
      if (dist) Object.keys(dist).forEach((k) => vals.add(Number(k)));
    }
    const ordered = Array.from(vals).sort((a, b) => a - b);
    let max = 0;
    const rows = questions
      .filter((q) => questionStats[q.name]?.distribution && Object.keys(questionStats[q.name].distribution).length > 0)
      .map((q) => {
        const dist = questionStats[q.name].distribution;
        const cells = ordered.map((v) => {
          const c = dist[v] ?? 0;
          max = Math.max(max, c);
          return { value: v, count: c };
        });
        return { name: q.title, qName: q.name, cells };
      });
    return { allValues: ordered, rows, maxCount: max };
  }, [questions, questionStats]);

  if (rows.length === 0) {
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
        Variant 3: Heatmap / matrix
      </Text>
      <Box overflowX="auto" w="100%">
        <Table.Root size="sm" minW="400px" fontSize="xs">
          <Table.Header>
            <Table.Row bg="bg.subtle">
              <Table.ColumnHeader whiteSpace="nowrap">Question</Table.ColumnHeader>
              {allValues.map((v) => (
                <Table.ColumnHeader key={v} textAlign="center" whiteSpace="nowrap">
                  {v}
                </Table.ColumnHeader>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((row) => (
              <Table.Row key={row.qName}>
                <Table.Cell maxW="200px" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis" title={row.name}>
                  {row.name.length > 35 ? row.name.slice(0, 32) + "..." : row.name}
                </Table.Cell>
                {row.cells.map((cell) => (
                  <Table.Cell
                    key={cell.value}
                    textAlign="center"
                    bg={getHeatColor(cell.count, maxCount)}
                    title={`${cell.value}: ${cell.count}`}
                  >
                    {cell.count > 0 ? cell.count : ""}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>
    </VStack>
  );
}
