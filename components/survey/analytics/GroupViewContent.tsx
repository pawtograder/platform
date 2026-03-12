"use client";

import type { Json } from "@/utils/supabase/SupabaseTypes";
import type { GroupAnalytics, QuestionStats, SurveyResponseWithContext } from "@/types/survey-analytics";
import type { SurveyAnalyticsSnapshot } from "@/hooks/useSurveyAnalytics";
import type { ScaleGroup } from "./ScaleGroupCharts";
import { VStack } from "@chakra-ui/react";
import { GroupDetailPanel } from "./GroupDetailPanel";
import { GroupSummaryCards } from "./GroupSummaryCards";
import { SeriesComparisonBlock } from "./SeriesComparisonBlock";

type SurveyInSeries = { id: string; title?: string | null; json?: Json; due_date?: string | null };

type GroupViewContentProps = {
  groupAnalytics: GroupAnalytics[];
  selectedGroupId: number | null;
  onSelectGroup: (groupId: number) => void;
  responses: SurveyResponseWithContext[];
  questionsToShow: { name: string; title: string; type: string }[];
  allQuestions: { name: string; title: string; type: string }[];
  surveyJson: Json;
  obfuscateStats?: boolean;
  courseStats: Record<string, QuestionStats>;
  selectedGroup: GroupAnalytics | null;
  /** Series comparison - when provided, shows compare UI and charts when comparing */
  surveysInSeries?: SurveyInSeries[];
  surveysToCompare?: string[];
  onSurveysToCompareChange?: (ids: string[]) => void;
  surveyId?: string;
  isComparing?: boolean;
  seriesLoading?: boolean;
  dataBySurveyId?: Record<string, SurveyAnalyticsSnapshot>;
  questionsByScaleGroup?: ScaleGroup[];
  valueLabelsByQuestion?: Record<string, Record<number, string>>;
  sectionFilter?: string;
};

export function GroupViewContent({
  groupAnalytics,
  selectedGroupId,
  onSelectGroup,
  responses,
  questionsToShow,
  allQuestions,
  surveyJson,
  obfuscateStats = false,
  courseStats,
  selectedGroup,
  surveyId = "",
  surveysInSeries = [],
  surveysToCompare = [],
  onSurveysToCompareChange,
  isComparing = false,
  seriesLoading = false,
  dataBySurveyId = {},
  questionsByScaleGroup = [],
  valueLabelsByQuestion = {},
  sectionFilter = "overall"
}: GroupViewContentProps) {
  const hasSeriesCompare = surveysInSeries.length > 1 && onSurveysToCompareChange && surveyId;

  return (
    <VStack align="stretch" gap={4} pt={4}>
      <GroupSummaryCards
        groupAnalytics={groupAnalytics}
        selectedGroupId={selectedGroupId}
        onSelectGroup={onSelectGroup}
        obfuscateStats={obfuscateStats}
      />
      {hasSeriesCompare && (
        <SeriesComparisonBlock
          surveysInSeries={surveysInSeries}
          surveysToCompare={surveysToCompare}
          onSurveysToCompareChange={onSurveysToCompareChange}
          surveyId={surveyId}
          isComparing={isComparing}
          seriesLoading={seriesLoading}
          questionsByScaleGroup={questionsByScaleGroup}
          valueLabelsByQuestion={valueLabelsByQuestion}
          dataBySurveyId={dataBySurveyId}
          sectionFilter={sectionFilter}
          selectedGroupId={selectedGroupId}
          obfuscateStats={obfuscateStats}
        />
      )}
      {selectedGroup && !isComparing && (
        <GroupDetailPanel
          group={selectedGroup}
          responses={responses}
          numericQuestions={questionsToShow}
          allQuestions={allQuestions}
          surveyJson={surveyJson}
          obfuscateNames={obfuscateStats}
          courseStats={courseStats}
        />
      )}
    </VStack>
  );
}
