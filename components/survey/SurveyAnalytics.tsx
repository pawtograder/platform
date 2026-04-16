"use client";

import { useObfuscatedGradesMode, useSurveysInSeries } from "@/hooks/useCourseController";
import { useSurveyAnalytics, useSurveySeriesAnalytics } from "@/hooks/useSurveyAnalytics";
import type { SurveyAnalyticsConfig } from "@/types/survey-analytics";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { Box, HStack, Heading, NativeSelect, Spinner, Tabs, Text, VStack } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { GroupViewContent, ScaleGroupCharts, SeriesComparisonBlock, SummaryCards } from "./analytics";
import { getAllQuestionsFromSurveyJson } from "./analytics/utils";
import {
  formatResponseValue,
  getValueLabelsFromSurveyJson,
  getScaleGroupKey,
  getScaleGroupLabel
} from "./analytics/utils";

type SurveyAnalyticsProps = {
  surveyId: string;
  surveyJson: Json;
  analyticsConfig?: SurveyAnalyticsConfig | null;
  classId: number;
  currentUserProfileId?: string;
  seriesId?: string;
  totalStudents?: number;
};

export default function SurveyAnalytics({
  surveyId,
  surveyJson,
  analyticsConfig = null,
  classId,
  currentUserProfileId,
  seriesId, // Reserved for future trend chart integration
  totalStudents = 0
}: SurveyAnalyticsProps) {
  const [viewMode, setViewMode] = useState<"course" | "group" | "mentor">("group");
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [sectionFilter, setSectionFilter] = useState<string>("overall");
  const [surveysToCompare, setSurveysToCompare] = useState<string[]>([surveyId]);
  const showMentorViewOnly = viewMode === "mentor";
  const obfuscateStats = useObfuscatedGradesMode();

  const { isLoading, error, courseStats, sectionAnalytics, groupAnalytics, totalResponses, responses } =
    useSurveyAnalytics(surveyId, classId, analyticsConfig, { surveyJson });

  const { surveys: surveysInSeries } = useSurveysInSeries(seriesId);
  const isComparing = surveysToCompare.length > 1;
  const surveyJsonBySurveyId = useMemo(
    () =>
      surveysInSeries.length > 0 ? Object.fromEntries(surveysInSeries.map((s) => [s.id, s.json as Json])) : undefined,
    [surveysInSeries]
  );
  const { dataBySurveyId, isLoading: seriesLoading } = useSurveySeriesAnalytics(
    isComparing ? surveysToCompare : [],
    classId,
    analyticsConfig,
    { surveyJsonBySurveyId }
  );

  const sectionOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: "overall", label: "Overall" }];
    sectionAnalytics.forEach((s) => {
      opts.push({
        value: `${s.sectionType}:${s.sectionId}`,
        label: `${s.sectionName} (${s.sectionType})`
      });
    });
    return opts;
  }, [sectionAnalytics]);

  const statsForCharts = useMemo(() => {
    if (sectionFilter === "overall") return courseStats;
    const [type, idStr] = sectionFilter.split(":");
    const id = Number(idStr);
    const section = sectionAnalytics.find((s) => s.sectionType === type && s.sectionId === id);
    return section?.questionStats ?? courseStats;
  }, [sectionFilter, sectionAnalytics, courseStats]);

  const allQuestions = useMemo(() => getAllQuestionsFromSurveyJson(surveyJson), [surveyJson]);
  const numericQuestionInfos = useMemo(
    () => allQuestions.filter((q) => ["rating", "nouislider", "text", "radiogroup", "checkbox"].includes(q.type)),
    [allQuestions]
  );
  const questionsToShow = useMemo(() => {
    if (analyticsConfig?.questions) {
      return numericQuestionInfos.filter((q) => analyticsConfig.questions[q.name]?.includeInAnalytics === true);
    }
    return numericQuestionInfos;
  }, [numericQuestionInfos, analyticsConfig]);

  const firstQuestion = questionsToShow.length > 0 ? questionsToShow[0] : null;
  const effectiveSelectedQuestion = firstQuestion?.name ?? null;
  const questionTitle = firstQuestion?.title ?? "";

  const filteredGroupAnalytics = useMemo(() => {
    if (showMentorViewOnly && currentUserProfileId) {
      return groupAnalytics.filter((g) => g.mentorId === currentUserProfileId);
    }
    return groupAnalytics;
  }, [groupAnalytics, showMentorViewOnly, currentUserProfileId]);

  const selectedGroup = useMemo(
    () => (selectedGroupId ? (groupAnalytics.find((g) => g.groupId === selectedGroupId) ?? null) : null),
    [groupAnalytics, selectedGroupId]
  );

  const valueLabelsByQuestion = useMemo(
    () => Object.fromEntries(questionsToShow.map((q) => [q.name, getValueLabelsFromSurveyJson(surveyJson, q.name)])),
    [questionsToShow, surveyJson]
  );

  const freeTextQuestions = useMemo(() => allQuestions.filter((q) => q.type === "comment"), [allQuestions]);
  const sectionFilteredResponses = useMemo(() => {
    if (sectionFilter === "overall") return responses;
    const [type, idStr] = sectionFilter.split(":");
    const id = Number(idStr);
    if (type === "lab") return responses.filter((r) => r.lab_section_id === id);
    if (type === "class") return responses.filter((r) => r.class_section_id === id);
    return responses;
  }, [responses, sectionFilter]);
  const questionsByScaleGroup = useMemo(() => {
    const groups = new Map<
      string,
      { questions: typeof questionsToShow; labels: Record<number, string>; groupLabel: string }
    >();
    for (const q of questionsToShow) {
      const labels = valueLabelsByQuestion[q.name] ?? {};
      const key = getScaleGroupKey(labels) || "other";
      if (!groups.has(key)) {
        groups.set(key, {
          questions: [],
          labels,
          groupLabel: getScaleGroupLabel(labels) || "Other"
        });
      }
      groups.get(key)!.questions.push(q);
    }
    return Array.from(groups.values());
  }, [questionsToShow, valueLabelsByQuestion]);

  const groupsWithAlerts = useMemo(
    () => new Set(groupAnalytics.filter((g) => g.alerts.length > 0).map((g) => g.groupId)),
    [groupAnalytics]
  );
  const alertsCount = groupsWithAlerts.size;

  const isGroupMentor = useMemo(
    () => !!currentUserProfileId && groupAnalytics.some((g) => g.mentorId === currentUserProfileId),
    [groupAnalytics, currentUserProfileId]
  );
  const myGroupsAlertsCount = useMemo(
    () =>
      isGroupMentor && currentUserProfileId
        ? groupAnalytics.filter((g) => g.mentorId === currentUserProfileId && g.alerts.length > 0).length
        : undefined,
    [groupAnalytics, currentUserProfileId, isGroupMentor]
  );

  const { displayResponses, displayStudents } = useMemo(() => {
    if (viewMode !== "course" || sectionFilter === "overall") {
      return { displayResponses: totalResponses, displayStudents: totalStudents };
    }
    const [type, idStr] = sectionFilter.split(":");
    const id = Number(idStr);
    const section = sectionAnalytics.find((s) => s.sectionType === type && s.sectionId === id);
    if (!section) return { displayResponses: totalResponses, displayStudents: totalStudents };
    return { displayResponses: section.responseCount, displayStudents: section.studentCount };
  }, [viewMode, sectionFilter, sectionAnalytics, totalResponses, totalStudents]);

  if (isLoading) {
    return (
      <Box p={4}>
        <HStack gap={2}>
          <Spinner size="sm" />
          <Text color="fg.muted">Loading analytics...</Text>
        </HStack>
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={4}>
        <Text color="red.500">Failed to load analytics: {error}</Text>
      </Box>
    );
  }

  if (numericQuestionInfos.length === 0) {
    return null;
  }

  return (
    <Box border="1px solid" borderColor="border" borderRadius="lg" p={6} mb={6}>
      <VStack align="stretch" gap={4}>
        <Heading size="md">Survey Analytics</Heading>
        <Text fontSize="sm" color="fg.muted">
          Diverging stacked bar charts grouped by Likert scale. Filter by section or compare across surveys in a series.
        </Text>

        <SummaryCards
          totalResponses={displayResponses}
          totalStudents={displayStudents}
          courseStats={courseStats}
          selectedQuestion={effectiveSelectedQuestion}
          questionTitle={questionTitle}
          alertsCount={alertsCount}
          myGroupsAlertsCount={myGroupsAlertsCount}
          isGroupMentor={isGroupMentor}
          obfuscateStats={obfuscateStats}
        />

        <Tabs.Root value={viewMode} onValueChange={(d) => setViewMode(d.value as typeof viewMode)}>
          <Tabs.List>
            <Tabs.Trigger value="course">Overview</Tabs.Trigger>
            <Tabs.Trigger value="group">By Group</Tabs.Trigger>
            {currentUserProfileId && <Tabs.Trigger value="mentor">My Groups</Tabs.Trigger>}
          </Tabs.List>

          <Tabs.Content value="course">
            <VStack align="stretch" gap={8} pt={4}>
              {sectionOptions.length > 1 && (
                <HStack gap={2} align="center">
                  <Text fontSize="sm" fontWeight="medium" color="fg.muted">
                    View by:
                  </Text>
                  <NativeSelect.Root size="sm" w="auto" minW="200px">
                    <NativeSelect.Field
                      bg="bg.subtle"
                      borderColor="border"
                      value={sectionFilter}
                      onChange={(e) => setSectionFilter(e.target.value)}
                    >
                      {sectionOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                </HStack>
              )}

              <SeriesComparisonBlock
                surveysInSeries={surveysInSeries}
                surveysToCompare={surveysToCompare}
                onSurveysToCompareChange={(ids: string[]) => setSurveysToCompare(ids.length > 0 ? ids : [surveyId])}
                surveyId={surveyId}
                isComparing={isComparing}
                seriesLoading={seriesLoading}
                questionsByScaleGroup={questionsByScaleGroup}
                valueLabelsByQuestion={valueLabelsByQuestion}
                dataBySurveyId={dataBySurveyId}
                sectionFilter={sectionFilter}
                selectedGroupId={null}
                obfuscateStats={obfuscateStats}
              />

              {!isComparing && (
                <ScaleGroupCharts
                  mode="single"
                  questionsByScaleGroup={questionsByScaleGroup}
                  statsForCharts={statsForCharts}
                  valueLabelsByQuestion={valueLabelsByQuestion}
                  courseMeanByQuestion={
                    !obfuscateStats && sectionFilter !== "overall" && courseStats
                      ? Object.fromEntries(
                          Object.entries(courseStats)
                            .filter(([, s]) => s?.mean != null)
                            .map(([q, s]) => [q, s!.mean!])
                        )
                      : undefined
                  }
                  obfuscateStats={obfuscateStats}
                />
              )}

              {/* Free text questions */}
              {freeTextQuestions.length > 0 && (
                <Box borderWidth="1px" borderColor="border" borderRadius="md" p={4}>
                  <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={3}>
                    Free text responses
                  </Text>
                  <VStack align="stretch" gap={6}>
                    {freeTextQuestions.map((q) => {
                      const submittedResponses = sectionFilteredResponses.filter((r) => r.is_submitted);
                      const valueLabels = getValueLabelsFromSurveyJson(surveyJson, q.name);
                      return (
                        <Box key={q.name} borderWidth="1px" borderColor="border" borderRadius="md" p={4}>
                          <Text fontSize="sm" fontWeight="medium" color="fg.muted" mb={2}>
                            {q.title}
                          </Text>
                          <VStack align="stretch" gap={2}>
                            {submittedResponses.map((r, i) => {
                              const val = (r.response as Record<string, unknown>)[q.name];
                              return (
                                <HStack
                                  key={r.response_id ?? r.profile_id}
                                  justify="space-between"
                                  align="start"
                                  gap={2}
                                >
                                  <Text fontSize="sm" color="fg.muted" minW="80px">
                                    {obfuscateStats ? `Respondent ${i + 1}` : (r.profile_name ?? "Unknown")}
                                  </Text>
                                  <Text fontSize="sm" flex="1" textAlign="right">
                                    {formatResponseValue(val, valueLabels)}
                                  </Text>
                                </HStack>
                              );
                            })}
                            {submittedResponses.length === 0 && (
                              <Text fontSize="sm" color="fg.muted">
                                No responses
                              </Text>
                            )}
                          </VStack>
                        </Box>
                      );
                    })}
                  </VStack>
                </Box>
              )}
            </VStack>
          </Tabs.Content>

          <Tabs.Content value="group">
            <GroupViewContent
              classId={classId}
              groupAnalytics={showMentorViewOnly && currentUserProfileId ? filteredGroupAnalytics : groupAnalytics}
              selectedGroupId={selectedGroupId}
              onSelectGroup={setSelectedGroupId}
              responses={responses}
              questionsToShow={questionsToShow}
              allQuestions={allQuestions}
              surveyJson={surveyJson}
              obfuscateStats={obfuscateStats}
              courseStats={courseStats}
              selectedGroup={selectedGroup}
              surveysInSeries={surveysInSeries}
              surveysToCompare={surveysToCompare}
              onSurveysToCompareChange={(ids: string[]) => setSurveysToCompare(ids.length > 0 ? ids : [surveyId])}
              surveyId={surveyId}
              isComparing={isComparing}
              seriesLoading={seriesLoading}
              dataBySurveyId={dataBySurveyId}
              questionsByScaleGroup={questionsByScaleGroup}
              valueLabelsByQuestion={valueLabelsByQuestion}
              sectionFilter="overall"
            />
          </Tabs.Content>

          <Tabs.Content value="mentor">
            <GroupViewContent
              classId={classId}
              groupAnalytics={filteredGroupAnalytics}
              selectedGroupId={selectedGroupId}
              onSelectGroup={setSelectedGroupId}
              responses={responses}
              questionsToShow={questionsToShow}
              allQuestions={allQuestions}
              surveyJson={surveyJson}
              obfuscateStats={obfuscateStats}
              courseStats={courseStats}
              selectedGroup={selectedGroup}
              surveysInSeries={surveysInSeries}
              surveysToCompare={surveysToCompare}
              onSurveysToCompareChange={(ids: string[]) => setSurveysToCompare(ids.length > 0 ? ids : [surveyId])}
              surveyId={surveyId}
              isComparing={isComparing}
              seriesLoading={seriesLoading}
              dataBySurveyId={dataBySurveyId}
              questionsByScaleGroup={questionsByScaleGroup}
              valueLabelsByQuestion={valueLabelsByQuestion}
              sectionFilter="overall"
            />
          </Tabs.Content>
        </Tabs.Root>
      </VStack>
    </Box>
  );
}
