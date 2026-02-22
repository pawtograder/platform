"use client";

import { createClient } from "@/utils/supabase/client";
import { Box, Heading, HStack, Table, Text, VStack, Badge, NativeSelect, Tabs } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { Model } from "survey-core";
import type { Json } from "@/utils/supabase/SupabaseTypes";

type GroupContextResponse = {
  response_id: string;
  profile_id: string;
  profile_name: string;
  is_submitted: boolean;
  submitted_at: string | null;
  response: Json;
  group_id: number | null;
  group_name: string | null;
  mentor_profile_id: string | null;
  mentor_name: string | null;
};

type NumericQuestion = {
  name: string;
  title: string;
};

function getNumericQuestions(surveyJson: Json): NumericQuestion[] {
  const questions: NumericQuestion[] = [];
  try {
    const survey = new Model(surveyJson);
    survey.getAllQuestions().forEach((q) => {
      if (q.getType() === "rating" || q.getType() === "nouislider" || q.getType() === "text") {
        questions.push({ name: q.name, title: q.title || q.name });
      }
    });
  } catch {
    /* ignore */
  }
  return questions;
}

function computeStats(values: number[]): { mean: number; median: number; min: number; max: number; count: number } {
  if (values.length === 0) return { mean: 0, median: 0, min: 0, max: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  return {
    mean: sum / values.length,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: values.length,
  };
}

function StatsRow({ label, stats, colorPalette }: { label: string; stats: ReturnType<typeof computeStats>; colorPalette?: string }) {
  if (stats.count === 0) return null;
  return (
    <Table.Row>
      <Table.Cell>
        <Text fontWeight="medium">{label}</Text>
      </Table.Cell>
      <Table.Cell>
        <Badge colorPalette={colorPalette || "blue"}>{stats.count}</Badge>
      </Table.Cell>
      <Table.Cell>{stats.mean.toFixed(2)}</Table.Cell>
      <Table.Cell>{stats.median.toFixed(2)}</Table.Cell>
      <Table.Cell>{stats.min}</Table.Cell>
      <Table.Cell>{stats.max}</Table.Cell>
    </Table.Row>
  );
}

export default function SurveyAnalytics({
  surveyId,
  surveyJson,
  classId,
}: {
  surveyId: string;
  surveyJson: Json;
  classId: number;
}) {
  const [responses, setResponses] = useState<GroupContextResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedQuestion, setSelectedQuestion] = useState<string>("");

  const numericQuestions = useMemo(() => getNumericQuestions(surveyJson), [surveyJson]);

  useEffect(() => {
    async function fetchResponses() {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("get_survey_responses_with_group_context", {
        p_survey_id: surveyId,
        p_class_id: classId,
      });
      if (!error && data) {
        setResponses(data as GroupContextResponse[]);
      }
      setLoading(false);
    }
    fetchResponses();
  }, [surveyId, classId]);

  useEffect(() => {
    if (numericQuestions.length > 0 && !selectedQuestion) {
      setSelectedQuestion(numericQuestions[0].name);
    }
  }, [numericQuestions, selectedQuestion]);

  const extractNumericValue = (response: Json, questionName: string): number | null => {
    if (!response || typeof response !== "object" || Array.isArray(response)) return null;
    const val = (response as Record<string, unknown>)[questionName];
    if (val === null || val === undefined) return null;
    const num = Number(val);
    return isNaN(num) ? null : num;
  };

  // Group responses by group
  const groupedData = useMemo(() => {
    const groups = new Map<string, { name: string; mentor: string | null; responses: GroupContextResponse[] }>();
    const ungrouped: GroupContextResponse[] = [];

    responses.forEach((r) => {
      if (r.group_id && r.group_name) {
        const key = String(r.group_id);
        if (!groups.has(key)) {
          groups.set(key, { name: r.group_name, mentor: r.mentor_name, responses: [] });
        }
        groups.get(key)!.responses.push(r);
      } else {
        ungrouped.push(r);
      }
    });

    return { groups, ungrouped };
  }, [responses]);

  // Compute stats for the selected question
  const statsData = useMemo(() => {
    if (!selectedQuestion) return null;

    // Overall stats
    const allValues = responses
      .filter((r) => r.is_submitted)
      .map((r) => extractNumericValue(r.response, selectedQuestion))
      .filter((v): v is number => v !== null);

    const overallStats = computeStats(allValues);

    // Per-group stats
    const groupStats: { name: string; mentor: string | null; stats: ReturnType<typeof computeStats> }[] = [];
    groupedData.groups.forEach((group) => {
      const values = group.responses
        .filter((r) => r.is_submitted)
        .map((r) => extractNumericValue(r.response, selectedQuestion))
        .filter((v): v is number => v !== null);
      groupStats.push({ name: group.name, mentor: group.mentor, stats: computeStats(values) });
    });

    // Ungrouped stats
    const ungroupedValues = groupedData.ungrouped
      .filter((r) => r.is_submitted)
      .map((r) => extractNumericValue(r.response, selectedQuestion))
      .filter((v): v is number => v !== null);

    return { overallStats, groupStats, ungroupedStats: computeStats(ungroupedValues) };
  }, [selectedQuestion, responses, groupedData]);

  if (loading) {
    return (
      <Box p={4}>
        <Text color="fg.muted">Loading analytics...</Text>
      </Box>
    );
  }

  if (numericQuestions.length === 0) {
    return null;
  }

  return (
    <Box border="1px solid" borderColor="border" borderRadius="lg" p={6} mb={6}>
      <VStack align="stretch" gap={4}>
        <Heading size="md">Survey Analytics</Heading>
        <Text fontSize="sm" color="fg.muted">
          Compare quantitative responses across groups. Select a numeric question to view statistics.
        </Text>

        <HStack gap={4} align="center">
          <Text fontSize="sm" fontWeight="medium">Question:</Text>
          <NativeSelect.Root size="sm" maxW="400px">
            <NativeSelect.Field
              value={selectedQuestion}
              onChange={(e) => setSelectedQuestion(e.target.value)}
            >
              {numericQuestions.map((q) => (
                <option key={q.name} value={q.name}>
                  {q.title}
                </option>
              ))}
            </NativeSelect.Field>
          </NativeSelect.Root>
        </HStack>

        {statsData && (
          <Tabs.Root defaultValue="by-group">
            <Tabs.List>
              <Tabs.Trigger value="by-group">By Group</Tabs.Trigger>
              <Tabs.Trigger value="overall">Overall</Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="by-group">
              <Box overflowX="auto">
                <Table.Root variant="outline" size="sm">
                  <Table.Header>
                    <Table.Row bg="bg.subtle">
                      <Table.ColumnHeader>Group</Table.ColumnHeader>
                      <Table.ColumnHeader>Responses</Table.ColumnHeader>
                      <Table.ColumnHeader>Mean</Table.ColumnHeader>
                      <Table.ColumnHeader>Median</Table.ColumnHeader>
                      <Table.ColumnHeader>Min</Table.ColumnHeader>
                      <Table.ColumnHeader>Max</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    <StatsRow label="All Respondents" stats={statsData.overallStats} colorPalette="purple" />
                    {statsData.groupStats.map((group) => (
                      <StatsRow
                        key={group.name}
                        label={`${group.name}${group.mentor ? ` (Mentor: ${group.mentor})` : ""}`}
                        stats={group.stats}
                        colorPalette="green"
                      />
                    ))}
                    {statsData.ungroupedStats.count > 0 && (
                      <StatsRow label="Ungrouped" stats={statsData.ungroupedStats} colorPalette="gray" />
                    )}
                  </Table.Body>
                </Table.Root>
              </Box>
            </Tabs.Content>

            <Tabs.Content value="overall">
              <Box overflowX="auto">
                <Table.Root variant="outline" size="sm">
                  <Table.Header>
                    <Table.Row bg="bg.subtle">
                      <Table.ColumnHeader>Metric</Table.ColumnHeader>
                      <Table.ColumnHeader>Value</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    <Table.Row>
                      <Table.Cell>Total Responses</Table.Cell>
                      <Table.Cell>{statsData.overallStats.count}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell>Mean</Table.Cell>
                      <Table.Cell>{statsData.overallStats.mean.toFixed(2)}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell>Median</Table.Cell>
                      <Table.Cell>{statsData.overallStats.median.toFixed(2)}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell>Min</Table.Cell>
                      <Table.Cell>{statsData.overallStats.min}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell>Max</Table.Cell>
                      <Table.Cell>{statsData.overallStats.max}</Table.Cell>
                    </Table.Row>
                  </Table.Body>
                </Table.Root>
              </Box>
            </Tabs.Content>
          </Tabs.Root>
        )}
      </VStack>
    </Box>
  );
}
