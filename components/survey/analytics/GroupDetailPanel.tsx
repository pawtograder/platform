"use client";

import type { Json } from "@/utils/supabase/SupabaseTypes";
import type { GroupAnalytics, SurveyResponseWithContext } from "@/types/survey-analytics";
import type { SurveyQuestionInfo } from "./utils";
import { Box, Card, HStack, Text, VStack } from "@chakra-ui/react";
import { ChoiceDistributionChart } from "./ChoiceDistributionChart";
import { DivergingStackedChart } from "./DivergingStackedChart";
import { formatResponseValue, getValueLabelsFromSurveyJson } from "./utils";
import { getScaleGroupKey, getScaleGroupLabel } from "./utils";

type GroupDetailPanelProps = {
  group: GroupAnalytics | null;
  responses: SurveyResponseWithContext[];
  numericQuestions: SurveyQuestionInfo[];
  allQuestions: SurveyQuestionInfo[];
  surveyJson: Json;
  obfuscateNames?: boolean;
};

export function GroupDetailPanel({
  group,
  responses,
  numericQuestions,
  allQuestions,
  surveyJson,
  obfuscateNames = false
}: GroupDetailPanelProps) {
  if (!group) {
    return (
      <Box p={4} bg="bg.subtle" borderRadius="md">
        <Text color="fg.muted" fontSize="sm">
          Select a group to view details
        </Text>
      </Box>
    );
  }

  const groupResponses = responses.filter((r) => r.is_submitted && r.group_id === group.groupId);
  const valueLabelsByQuestion = Object.fromEntries(
    allQuestions.map((q) => [q.name, getValueLabelsFromSurveyJson(surveyJson, q.name)])
  );

  const numericQuestionsByScale = (() => {
    const groups = new Map<string, SurveyQuestionInfo[]>();
    for (const q of numericQuestions) {
      const labels = valueLabelsByQuestion[q.name] ?? {};
      const key = getScaleGroupKey(labels) || "other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(q);
    }
    return Array.from(groups.entries()).map(([key, questions]) => ({
      groupLabel: key ? getScaleGroupLabel(valueLabelsByQuestion[questions[0].name] ?? {}) : "Other",
      questions
    }));
  })();

  return (
    <Card.Root>
      <Card.Header>
        <Text fontWeight="semibold">{group.groupName}</Text>
        {group.mentorName && (
          <Text fontSize="sm" color="fg.muted">
            Mentor: {group.mentorName}
          </Text>
        )}
      </Card.Header>
      <Card.Body>
        <VStack align="stretch" gap={6}>
          {numericQuestionsByScale.map(({ groupLabel, questions }) => {
            const isCheckbox = questions[0]?.type === "checkbox";
            return (
              <Box key={groupLabel} borderWidth="1px" borderColor="border" borderRadius="md" p={4}>
                <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={3}>
                  {groupLabel}
                </Text>
                {isCheckbox ? (
                  <ChoiceDistributionChart
                    questions={questions}
                    questionStats={group.questionStats}
                    valueLabelsByQuestion={Object.fromEntries(
                      questions.map((q) => [q.name, valueLabelsByQuestion[q.name] ?? {}])
                    )}
                  />
                ) : (
                  <DivergingStackedChart
                    questions={questions}
                    questionStats={group.questionStats}
                    valueLabelsByQuestion={Object.fromEntries(
                      questions.map((q) => [q.name, valueLabelsByQuestion[q.name] ?? {}])
                    )}
                  />
                )}
              </Box>
            );
          })}

          {allQuestions.map((q) => {
            const isNumeric = numericQuestions.some((nq) => nq.name === q.name);
            if (isNumeric) return null;

            return (
              <Box key={q.name} borderWidth="1px" borderColor="border" borderRadius="md" p={4}>
                <Text fontSize="sm" fontWeight="medium" color="fg.muted" mb={2}>
                  {q.title}
                </Text>
                <VStack align="stretch" gap={2}>
                  {groupResponses.map((r, i) => {
                    const val = (r.response as Record<string, unknown>)[q.name];
                    const labels = valueLabelsByQuestion[q.name];
                    return (
                      <HStack key={r.response_id} justify="space-between" align="start" gap={2}>
                        <Text fontSize="sm" color="fg.muted" minW="80px">
                          {obfuscateNames ? `Respondent ${i + 1}` : (r.profile_name ?? "Unknown")}
                        </Text>
                        <Text fontSize="sm" flex="1" textAlign="right">
                          {formatResponseValue(val, labels)}
                        </Text>
                      </HStack>
                    );
                  })}
                  {groupResponses.length === 0 && (
                    <Text fontSize="sm" color="fg.muted">
                      No responses
                    </Text>
                  )}
                </VStack>
              </Box>
            );
          })}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
