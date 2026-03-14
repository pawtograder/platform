"use client";

import type { SurveyAnalyticsSnapshot } from "@/hooks/useSurveyAnalytics";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import type { QuestionStats } from "@/types/survey-analytics";
import type { SurveyQuestionInfo } from "./utils";
import { Box, Text, VStack } from "@chakra-ui/react";
import { ChoiceDistributionChart } from "./ChoiceDistributionChart";
import { DivergingStackedChart } from "./DivergingStackedChart";
import { DivergingStackedChartMultiSeries } from "./DivergingStackedChartMultiSeries";
import { getValueLabelsFromSurveyJson } from "./utils";

export type ScaleGroup = {
  questions: SurveyQuestionInfo[];
  labels: Record<number, string>;
  groupLabel: string;
};

export type SeriesDataItem = {
  surveyId: string;
  surveyLabel: string;
  surveyColor: string;
  questionStats: Record<string, QuestionStats>;
  valueLabelsByQuestion: Record<string, Record<number, string>>;
};

type ScaleGroupChartsSingleProps = {
  questionsByScaleGroup: ScaleGroup[];
  statsForCharts: Record<string, QuestionStats>;
  valueLabelsByQuestion: Record<string, Record<number, string>>;
  courseMeanByQuestion?: Record<string, number>;
  obfuscateStats?: boolean;
};

type ScaleGroupChartsMultiProps = {
  questionsByScaleGroup: ScaleGroup[];
  seriesDataByGroup: Map<string, SeriesDataItem[]>;
  valueLabelsByQuestion?: Record<string, Record<number, string>>;
  courseMeanByQuestion?: Record<string, number>;
  obfuscateStats?: boolean;
};

function SingleModeCharts({
  questionsByScaleGroup,
  statsForCharts,
  valueLabelsByQuestion,
  courseMeanByQuestion,
  obfuscateStats = false
}: ScaleGroupChartsSingleProps) {
  return (
    <>
      {questionsByScaleGroup.map((group) => {
        const isCheckbox = group.questions[0]?.type === "checkbox";
        return (
          <Box key={group.groupLabel} borderWidth="1px" borderColor="border" borderRadius="md" p={4}>
            <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={3}>
              {isCheckbox ? (group.questions[0]?.title ?? group.groupLabel) : group.groupLabel}
            </Text>
            {isCheckbox ? (
              <ChoiceDistributionChart
                questions={group.questions}
                questionStats={statsForCharts}
                valueLabelsByQuestion={Object.fromEntries(
                  group.questions.map((q) => [q.name, valueLabelsByQuestion[q.name] ?? {}])
                )}
              />
            ) : (
              <DivergingStackedChart
                questions={group.questions}
                questionStats={statsForCharts}
                valueLabelsByQuestion={Object.fromEntries(
                  group.questions.map((q) => [q.name, valueLabelsByQuestion[q.name] ?? {}])
                )}
                courseMeanByQuestion={
                  !obfuscateStats && courseMeanByQuestion
                    ? Object.fromEntries(
                        group.questions
                          .filter((q) => courseMeanByQuestion[q.name] != null)
                          .map((q) => [q.name, courseMeanByQuestion[q.name]!])
                      )
                    : undefined
                }
              />
            )}
          </Box>
        );
      })}
    </>
  );
}

function MultiModeCharts({
  questionsByScaleGroup,
  seriesDataByGroup,
  courseMeanByQuestion,
  obfuscateStats = false
}: ScaleGroupChartsMultiProps) {
  return (
    <VStack align="stretch" gap={6}>
      {questionsByScaleGroup.map((group) => {
        const isCheckbox = group.questions[0]?.type === "checkbox";
        const seriesData = seriesDataByGroup.get(group.groupLabel) ?? [];
        if (seriesData.length === 0) return null;

        return (
          <Box key={group.groupLabel}>
            <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={2}>
              {isCheckbox ? (group.questions[0]?.title ?? group.groupLabel) : group.groupLabel}
            </Text>
            {isCheckbox ? (
              <VStack align="stretch" gap={4}>
                {seriesData.map((s) => (
                  <Box
                    key={s.surveyId}
                    borderWidth="1px"
                    borderColor="border"
                    borderRadius="md"
                    p={3}
                    borderLeftWidth="4px"
                    borderLeftColor={s.surveyColor}
                  >
                    <Text fontSize="xs" color="fg.muted" mb={2}>
                      {s.surveyLabel}
                    </Text>
                    <ChoiceDistributionChart
                      questions={group.questions}
                      questionStats={s.questionStats}
                      valueLabelsByQuestion={Object.fromEntries(
                        group.questions.map((q) => [q.name, s.valueLabelsByQuestion[q.name] ?? {}])
                      )}
                    />
                  </Box>
                ))}
              </VStack>
            ) : (
              <DivergingStackedChartMultiSeries
                questions={group.questions.map((q) => ({ name: q.name, title: q.title ?? q.name }))}
                series={seriesData}
                courseMeanByQuestion={
                  !obfuscateStats && courseMeanByQuestion
                    ? Object.fromEntries(
                        group.questions
                          .filter((q) => courseMeanByQuestion[q.name] != null)
                          .map((q) => [q.name, courseMeanByQuestion[q.name]!])
                      )
                    : undefined
                }
              />
            )}
          </Box>
        );
      })}
    </VStack>
  );
}

export type ScaleGroupChartsProps =
  | ({ mode: "single" } & ScaleGroupChartsSingleProps)
  | ({ mode: "multi" } & Omit<ScaleGroupChartsMultiProps, "surveysInSeries">);

export function ScaleGroupCharts(props: ScaleGroupChartsProps) {
  if (props.mode === "single") {
    const { mode, ...rest } = props;
    void mode;
    return <SingleModeCharts {...rest} />;
  }
  const { mode, valueLabelsByQuestion, ...rest } = props;
  void mode;
  void valueLabelsByQuestion;
  return <MultiModeCharts {...rest} />;
}

/** Build seriesData map for multi-mode from dataBySurveyId and context */
export function buildSeriesDataByGroup(
  questionsByScaleGroup: ScaleGroup[],
  surveysToCompare: string[],
  surveysInSeries: { id: string; title?: string | null; json?: Json; due_date?: string | null }[],
  dataBySurveyId: Record<string, SurveyAnalyticsSnapshot>,
  sectionFilter: string,
  selectedGroupId: number | null,
  valueLabelsByQuestion: Record<string, Record<number, string>>,
  SERIES_COLORS: string[]
): Map<string, SeriesDataItem[]> {
  const monthLabelsFromDueDate = surveysToCompare.map((sid) => {
    const s = surveysInSeries.find((x) => x.id === sid);
    const dueDate = s?.due_date;
    return dueDate ? new Date(dueDate).toLocaleDateString("en-US", { month: "short", year: "2-digit" }) : null;
  });
  const hasDuplicateDueDateLabels =
    new Set(monthLabelsFromDueDate.filter(Boolean)).size < monthLabelsFromDueDate.filter(Boolean).length;

  const result = new Map<string, SeriesDataItem[]>();

  for (const group of questionsByScaleGroup) {
    const seriesData = surveysToCompare
      .map((sid, i) => {
        const snapshot = dataBySurveyId[sid];
        if (!snapshot) return null;

        let questionStats: Record<string, QuestionStats>;
        if (selectedGroupId != null && snapshot.groupAnalytics) {
          const g = snapshot.groupAnalytics.find((ga) => ga.groupId === selectedGroupId);
          questionStats = g?.questionStats ?? snapshot.courseStats ?? {};
        } else if (sectionFilter === "overall") {
          questionStats = snapshot.courseStats;
        } else {
          const [type, idStr] = sectionFilter.split(":");
          const section = snapshot.sectionAnalytics?.find(
            (sec) => sec.sectionType === type && sec.sectionId === Number(idStr)
          );
          questionStats = section?.questionStats ?? {};
        }

        const s = surveysInSeries.find((x) => x.id === sid);
        const labels = s?.json
          ? Object.fromEntries(
              group.questions.map((q) => [q.name, getValueLabelsFromSurveyJson(s.json as Json, q.name)])
            )
          : Object.fromEntries(group.questions.map((q) => [q.name, valueLabelsByQuestion[q.name] ?? {}]));

        const dueDate = s?.due_date;
        const title = s?.title;
        const surveyLabel =
          hasDuplicateDueDateLabels && title
            ? title
            : dueDate
              ? new Date(dueDate).toLocaleDateString("en-US", { month: "short", year: "2-digit" })
              : (title ?? sid.slice(0, 8));

        return {
          surveyId: sid,
          surveyLabel,
          surveyColor: SERIES_COLORS[i % SERIES_COLORS.length],
          questionStats,
          valueLabelsByQuestion: labels
        };
      })
      .filter((s): s is SeriesDataItem => s != null)
      .filter((s) =>
        group.questions.some(
          (q) => s.questionStats[q.name]?.distribution && Object.keys(s.questionStats[q.name].distribution).length > 0
        )
      );

    if (seriesData.length > 0) {
      result.set(group.groupLabel, seriesData);
    }
  }

  return result;
}
