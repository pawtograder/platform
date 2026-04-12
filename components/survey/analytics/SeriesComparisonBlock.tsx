"use client";

import type { Json } from "@/utils/supabase/SupabaseTypes";
import type { SurveyAnalyticsSnapshot } from "@/hooks/useSurveyAnalytics";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { SeriesComparisonCheckboxes } from "./SeriesComparisonCheckboxes";
import { ScaleGroupCharts, buildSeriesDataByGroup, type ScaleGroup } from "./ScaleGroupCharts";

type SurveyInSeries = { id: string; title?: string | null; json?: Json; due_date?: string | null };

const SERIES_COLORS = ["#3B82F6", "#22C55E", "#EAB308", "#A855F7", "#EC4899"];

type SeriesComparisonBlockProps = {
  surveysInSeries: SurveyInSeries[];
  surveysToCompare: string[];
  onSurveysToCompareChange: (ids: string[]) => void;
  surveyId: string;
  isComparing: boolean;
  seriesLoading: boolean;
  questionsByScaleGroup: ScaleGroup[];
  valueLabelsByQuestion: Record<string, Record<number, string>>;
  dataBySurveyId: Record<string, SurveyAnalyticsSnapshot>;
  sectionFilter: string;
  selectedGroupId: number | null;
  obfuscateStats?: boolean;
};

export function SeriesComparisonBlock({
  surveysInSeries,
  surveysToCompare,
  onSurveysToCompareChange,
  surveyId,
  isComparing,
  seriesLoading,
  questionsByScaleGroup,
  valueLabelsByQuestion,
  dataBySurveyId,
  sectionFilter,
  selectedGroupId,
  obfuscateStats = false
}: SeriesComparisonBlockProps) {
  if (surveysInSeries.length <= 1) return null;

  const seriesDataByGroup = buildSeriesDataByGroup(
    questionsByScaleGroup,
    surveysToCompare,
    surveysInSeries,
    dataBySurveyId,
    sectionFilter,
    selectedGroupId,
    valueLabelsByQuestion,
    SERIES_COLORS
  );

  const courseMeanByQuestion =
    !obfuscateStats && sectionFilter !== "overall" && surveysToCompare[0]
      ? (() => {
          const snapshot = dataBySurveyId[surveysToCompare[0]];
          const stats = snapshot?.courseStats;
          if (!stats) return undefined;
          return Object.fromEntries(
            Object.entries(stats)
              .filter(([, s]) => s?.mean != null)
              .map(([q, s]) => [q, s!.mean!])
          );
        })()
      : undefined;

  return (
    <Box>
      <SeriesComparisonCheckboxes
        surveysInSeries={surveysInSeries}
        surveysToCompare={surveysToCompare}
        onSurveysToCompareChange={(ids) => onSurveysToCompareChange(ids.length > 0 ? ids : [surveyId])}
      />
      {isComparing && (
        <>
          {seriesLoading ? (
            <HStack gap={2} mt={4}>
              <Spinner size="sm" />
              <Text color="fg.muted">Loading comparison data...</Text>
            </HStack>
          ) : (
            <VStack align="stretch" gap={6} mt={4}>
              <ScaleGroupCharts
                mode="multi"
                questionsByScaleGroup={questionsByScaleGroup}
                seriesDataByGroup={seriesDataByGroup}
                valueLabelsByQuestion={valueLabelsByQuestion}
                courseMeanByQuestion={courseMeanByQuestion}
                obfuscateStats={obfuscateStats}
              />
            </VStack>
          )}
        </>
      )}
    </Box>
  );
}
