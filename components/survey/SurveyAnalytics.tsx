"use client";

import { useObfuscatedGradesMode, useSurveysInSeries } from "@/hooks/useCourseController";
import { useSurveyAnalytics, useSurveySeriesAnalytics } from "@/hooks/useSurveyAnalytics";
import type { SurveyAnalyticsConfig } from "@/types/survey-analytics";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { Box, Checkbox, HStack, Heading, NativeSelect, Spinner, Tabs, Text, VStack } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import {
  ChoiceDistributionChart,
  DivergingStackedChart,
  GroupDetailPanel,
  GroupSummaryCards,
  SummaryCards
} from "./analytics";
import { getAllQuestionsFromSurveyJson } from "./analytics/utils";
import { getValueLabelsFromSurveyJson, getScaleGroupKey, getScaleGroupLabel } from "./analytics/utils";

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
  const { dataBySurveyId, isLoading: seriesLoading } = useSurveySeriesAnalytics(
    isComparing ? surveysToCompare : [],
    classId,
    analyticsConfig
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
      return numericQuestionInfos.filter((q) => analyticsConfig.questions[q.name]?.includeInAnalytics !== false);
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

  const SERIES_COLORS = ["#3B82F6", "#22C55E", "#EAB308", "#A855F7", "#EC4899"];

  const valueLabelsByQuestion = useMemo(
    () => Object.fromEntries(questionsToShow.map((q) => [q.name, getValueLabelsFromSurveyJson(surveyJson, q.name)])),
    [questionsToShow, surveyJson]
  );

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
          totalResponses={totalResponses}
          totalStudents={totalStudents}
          courseStats={courseStats}
          selectedQuestion={effectiveSelectedQuestion}
          questionTitle={questionTitle}
          alertsCount={alertsCount}
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

              {/* Survey series comparison */}
              {surveysInSeries.length > 1 && (
                <Box borderWidth="1px" borderColor="border" borderRadius="md" p={4}>
                  <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={3}>
                    Compare across surveys in series
                  </Text>
                  <HStack gap={4} flexWrap="wrap" mb={4}>
                    {surveysInSeries.map((s) => {
                      const sid = s.id;
                      const checked = surveysToCompare.includes(sid);
                      return (
                        <Checkbox.Root
                          key={sid}
                          checked={checked}
                          onCheckedChange={(e) => {
                            const v = e.checked as boolean;
                            setSurveysToCompare((prev) => {
                              const next = v ? [...prev, sid] : prev.filter((id) => id !== sid);
                              return next.length > 0 ? next : [surveyId];
                            });
                          }}
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control />
                          <Checkbox.Label fontSize="sm">
                            {(s as { title?: string }).title ?? `Survey ${sid.slice(0, 8)}`}
                          </Checkbox.Label>
                        </Checkbox.Root>
                      );
                    })}
                  </HStack>
                  {isComparing && (
                    <>
                      {seriesLoading ? (
                        <HStack gap={2}>
                          <Spinner size="sm" />
                          <Text color="fg.muted">Loading comparison data...</Text>
                        </HStack>
                      ) : (
                        <VStack align="stretch" gap={6}>
                          {questionsByScaleGroup.map((group) => {
                            const isCheckbox = group.questions[0]?.type === "checkbox";
                            const monthLabelsFromDueDate = surveysToCompare.map((sid) => {
                              const s = surveysInSeries.find((x) => x.id === sid);
                              const dueDate = (s as { due_date?: string | null })?.due_date;
                              return dueDate
                                ? new Date(dueDate).toLocaleDateString("en-US", {
                                    month: "short",
                                    year: "2-digit"
                                  })
                                : null;
                            });
                            const hasDuplicateDueDateLabels =
                              new Set(monthLabelsFromDueDate.filter(Boolean)).size <
                              monthLabelsFromDueDate.filter(Boolean).length;
                            const seriesData = surveysToCompare
                              .map((sid, i) => {
                                const snapshot = dataBySurveyId[sid];
                                const s = surveysInSeries.find((x) => x.id === sid);
                                const sectionStats =
                                  sectionFilter === "overall"
                                    ? snapshot?.courseStats
                                    : (() => {
                                        const [type, idStr] = sectionFilter.split(":");
                                        const section = snapshot?.sectionAnalytics.find(
                                          (sec) => sec.sectionType === type && sec.sectionId === Number(idStr)
                                        );
                                        return section?.questionStats;
                                      })();
                                const labels = s?.json
                                  ? Object.fromEntries(
                                      group.questions.map((q) => [
                                        q.name,
                                        getValueLabelsFromSurveyJson(s.json as Json, q.name)
                                      ])
                                    )
                                  : Object.fromEntries(
                                      group.questions.map((q) => [q.name, valueLabelsByQuestion[q.name] ?? {}])
                                    );
                                const dueDate = (s as { due_date?: string | null })?.due_date;
                                const title = (s as { title?: string })?.title;
                                const surveyLabel =
                                  hasDuplicateDueDateLabels && title
                                    ? title
                                    : dueDate
                                      ? new Date(dueDate).toLocaleDateString("en-US", {
                                          month: "short",
                                          year: "2-digit"
                                        })
                                      : (title ?? sid.slice(0, 8));
                                return {
                                  surveyId: sid,
                                  surveyLabel,
                                  surveyColor: SERIES_COLORS[i % SERIES_COLORS.length],
                                  questionStats: sectionStats ?? {},
                                  valueLabelsByQuestion: labels
                                };
                              })
                              .filter((s) =>
                                group.questions.some(
                                  (q) =>
                                    s.questionStats[q.name]?.distribution &&
                                    Object.keys(s.questionStats[q.name].distribution).length > 0
                                )
                              );
                            if (seriesData.length === 0) return null;
                            return (
                              <Box key={group.groupLabel}>
                                <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={2}>
                                  {group.groupLabel}
                                </Text>
                                <VStack align="stretch" gap={4}>
                                  {seriesData.map((s) => (
                                    <Box key={s.surveyId}>
                                      <Text fontSize="xs" color="fg.muted" mb={1}>
                                        {s.surveyLabel}
                                      </Text>
                                      {isCheckbox ? (
                                        <ChoiceDistributionChart
                                          questions={group.questions}
                                          questionStats={s.questionStats}
                                          valueLabelsByQuestion={Object.fromEntries(
                                            group.questions.map((q) => [q.name, s.valueLabelsByQuestion[q.name] ?? {}])
                                          )}
                                        />
                                      ) : (
                                        <DivergingStackedChart
                                          questions={group.questions}
                                          questionStats={s.questionStats}
                                          valueLabelsByQuestion={Object.fromEntries(
                                            group.questions.map((q) => [q.name, s.valueLabelsByQuestion[q.name] ?? {}])
                                          )}
                                        />
                                      )}
                                    </Box>
                                  ))}
                                </VStack>
                              </Box>
                            );
                          })}
                        </VStack>
                      )}
                    </>
                  )}
                </Box>
              )}

              {/* Bar charts grouped by scale (diverging for Likert, choice distribution for checkbox) */}
              {questionsByScaleGroup.map((group) => {
                const isCheckbox = group.questions[0]?.type === "checkbox";
                return (
                  <Box key={group.groupLabel} borderWidth="1px" borderColor="border" borderRadius="md" p={4}>
                    <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={3}>
                      {group.groupLabel}
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
                      />
                    )}
                  </Box>
                );
              })}
            </VStack>
          </Tabs.Content>

          <Tabs.Content value="group">
            <VStack align="stretch" gap={4} pt={4}>
              <GroupSummaryCards
                groupAnalytics={showMentorViewOnly && currentUserProfileId ? filteredGroupAnalytics : groupAnalytics}
                selectedGroupId={selectedGroupId}
                onSelectGroup={setSelectedGroupId}
                obfuscateStats={obfuscateStats}
              />
              {selectedGroup && (
                <GroupDetailPanel
                  group={selectedGroup}
                  responses={responses}
                  numericQuestions={questionsToShow}
                  allQuestions={allQuestions}
                  surveyJson={surveyJson}
                  obfuscateNames={obfuscateStats}
                />
              )}
            </VStack>
          </Tabs.Content>

          <Tabs.Content value="mentor">
            <VStack align="stretch" gap={4} pt={4}>
              <GroupSummaryCards
                groupAnalytics={filteredGroupAnalytics}
                selectedGroupId={selectedGroupId}
                onSelectGroup={setSelectedGroupId}
                obfuscateStats={obfuscateStats}
              />
              {selectedGroup && (
                <GroupDetailPanel
                  group={selectedGroup}
                  responses={responses}
                  numericQuestions={questionsToShow}
                  allQuestions={allQuestions}
                  surveyJson={surveyJson}
                  obfuscateNames={obfuscateStats}
                />
              )}
            </VStack>
          </Tabs.Content>
        </Tabs.Root>
      </VStack>
    </Box>
  );
}
