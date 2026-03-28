"use client";

import type { Json } from "@/utils/supabase/SupabaseTypes";
import type { GroupAnalytics, QuestionStats, SurveyResponseWithContext } from "@/types/survey-analytics";
import type { SurveyAnalyticsSnapshot } from "@/hooks/useSurveyAnalytics";
import type { ScaleGroup } from "./ScaleGroupCharts";
import {
  GROUP_ANALYTICS_ALL_SECTIONS,
  buildGroupSectionBuckets,
  groupAnalyticsSectionStorageKey,
  isValidStoredSectionKey
} from "./groupSectionUtils";
import { Box, Heading, HStack, NativeSelect, Text, VStack } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { GroupDetailPanel } from "./GroupDetailPanel";
import { GroupSummaryCards } from "./GroupSummaryCards";
import { SeriesComparisonBlock } from "./SeriesComparisonBlock";

type SurveyInSeries = { id: string; title?: string | null; json?: Json; due_date?: string | null };

type GroupViewContentProps = {
  classId: number;
  groupAnalytics: GroupAnalytics[];
  selectedGroupId: number | null;
  onSelectGroup: (groupId: number | null) => void;
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
  classId,
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

  const sectionBuckets = useMemo(
    () => buildGroupSectionBuckets(groupAnalytics, responses),
    [groupAnalytics, responses]
  );

  const storageKey = groupAnalyticsSectionStorageKey(classId, surveyId);

  const [studentSectionKey, setStudentSectionKey] = useState<string>(GROUP_ANALYTICS_ALL_SECTIONS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (isValidStoredSectionKey(raw)) {
        setStudentSectionKey(raw);
      }
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  useEffect(() => {
    if (studentSectionKey === GROUP_ANALYTICS_ALL_SECTIONS) return;
    const exists = sectionBuckets.some((b) => b.key === studentSectionKey);
    if (!exists) {
      setStudentSectionKey(GROUP_ANALYTICS_ALL_SECTIONS);
      try {
        localStorage.setItem(storageKey, GROUP_ANALYTICS_ALL_SECTIONS);
      } catch {
        /* ignore */
      }
    }
  }, [sectionBuckets, studentSectionKey, storageKey]);

  const showSectionedAllView = studentSectionKey === GROUP_ANALYTICS_ALL_SECTIONS && sectionBuckets.length > 1;
  const activeBucket =
    studentSectionKey === GROUP_ANALYTICS_ALL_SECTIONS ? null : sectionBuckets.find((b) => b.key === studentSectionKey);
  const groupCardsForFlatView =
    activeBucket?.groups ?? (sectionBuckets.length === 1 ? sectionBuckets[0]!.groups : groupAnalytics);

  useEffect(() => {
    if (selectedGroupId == null) return;

    const showAllSectionsGrid = studentSectionKey === GROUP_ANALYTICS_ALL_SECTIONS && sectionBuckets.length > 1;
    const bucketForFlat =
      studentSectionKey === GROUP_ANALYTICS_ALL_SECTIONS
        ? null
        : sectionBuckets.find((b) => b.key === studentSectionKey);
    const cardsForFlat =
      bucketForFlat?.groups ?? (sectionBuckets.length === 1 ? sectionBuckets[0]!.groups : groupAnalytics);

    const visible = showAllSectionsGrid
      ? sectionBuckets.some((b) => b.groups.some((g) => g.groupId === selectedGroupId))
      : cardsForFlat.some((g) => g.groupId === selectedGroupId);

    if (!visible) {
      onSelectGroup(null);
    }
  }, [selectedGroupId, studentSectionKey, sectionBuckets, groupAnalytics, onSelectGroup]);

  const persistStudentSection = (key: string) => {
    setStudentSectionKey(key);
    try {
      localStorage.setItem(storageKey, key);
    } catch {
      /* ignore */
    }
  };

  return (
    <VStack align="stretch" gap={4} pt={4}>
      {sectionBuckets.length > 0 && (
        <Box>
          <HStack gap={3} flexWrap="wrap" align="center" mb={showSectionedAllView ? 3 : 2}>
            <Text fontSize="sm" fontWeight="medium" color="fg.muted">
              Class section
            </Text>
            <NativeSelect.Root size="sm" w={{ base: "100%", sm: "280px" }}>
              <NativeSelect.Field
                value={studentSectionKey}
                onChange={(e) => persistStudentSection(e.target.value)}
                bg="bg.subtle"
                borderColor="border"
              >
                <option value={GROUP_ANALYTICS_ALL_SECTIONS}>All sections</option>
                {sectionBuckets.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </HStack>
          {showSectionedAllView && (
            <Text fontSize="xs" color="fg.muted">
              Groups that include students from more than one class section are listed under each of those sections.
            </Text>
          )}
        </Box>
      )}

      {showSectionedAllView ? (
        <VStack align="stretch" gap={8}>
          {sectionBuckets.map((bucket) => (
            <Box key={bucket.key}>
              <Heading size="sm" mb={3}>
                {bucket.label}
              </Heading>
              <GroupSummaryCards
                groupAnalytics={bucket.groups}
                selectedGroupId={selectedGroupId}
                onSelectGroup={onSelectGroup}
                obfuscateStats={obfuscateStats}
              />
            </Box>
          ))}
        </VStack>
      ) : (
        <GroupSummaryCards
          groupAnalytics={groupCardsForFlatView}
          selectedGroupId={selectedGroupId}
          onSelectGroup={onSelectGroup}
          obfuscateStats={obfuscateStats}
        />
      )}
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
