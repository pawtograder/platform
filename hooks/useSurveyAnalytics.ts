"use client";

import { createClient } from "@/utils/supabase/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Model } from "survey-core";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import type {
  SurveyResponseWithContext,
  SurveyAnalyticsConfig,
  GroupAnalytics,
  SectionAnalytics,
  QuestionStats,
  Alert
} from "@/types/survey-analytics";
import {
  computeStats,
  getDistributionWithDelta,
  extractNumericValue,
  extractCheckboxFlagValues
} from "@/components/survey/analytics/utils";

type NumericQuestion = { name: string; title: string; type: string };

function getNumericQuestions(surveyJson: Json): NumericQuestion[] {
  const questions: NumericQuestion[] = [];
  try {
    const survey = new Model(surveyJson);
    survey.getAllQuestions().forEach((q) => {
      const type = q.getType();
      if (
        type === "rating" ||
        type === "nouislider" ||
        type === "text" ||
        type === "radiogroup" ||
        type === "checkbox"
      ) {
        questions.push({ name: q.name, title: q.title || q.name, type });
      }
    });
  } catch {
    /* ignore */
  }
  return questions;
}

function getQuestionType(surveyJson: Json, questionName: string): string | null {
  try {
    const survey = new Model(surveyJson);
    const q = survey.getQuestionByName(questionName);
    return q ? q.getType() : null;
  } catch {
    return null;
  }
}

function getQuestionsToAnalyze(surveyJson: Json, analyticsConfig: SurveyAnalyticsConfig | null): NumericQuestion[] {
  const numericQuestions = getNumericQuestions(surveyJson);
  if (!analyticsConfig?.questions) return numericQuestions;

  return numericQuestions.filter((q) => {
    const config = analyticsConfig.questions[q.name];
    return config?.includeInAnalytics !== false;
  });
}

/** Pure helper: compute group analytics from submitted responses. Reused by useSurveyAnalytics and useSurveySeriesAnalytics. */
export function computeGroupAnalyticsFromResponses(
  submitted: SurveyResponseWithContext[],
  surveyJson: Json | null,
  analyticsConfig: SurveyAnalyticsConfig | null,
  courseStats: Record<string, QuestionStats>
): GroupAnalytics[] {
  const groupMap = new Map<
    number,
    { name: string; mentorId: string | null; mentorName: string | null; responses: SurveyResponseWithContext[] }
  >();

  submitted.forEach((r) => {
    if (r.group_id && r.group_name) {
      const key = r.group_id;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          name: r.group_name,
          mentorId: r.mentor_profile_id,
          mentorName: r.mentor_name,
          responses: []
        });
      }
      groupMap.get(key)!.responses.push(r);
    }
  });

  const groupAnalytics: GroupAnalytics[] = [];
  const config = analyticsConfig?.questions;

  for (const [groupId, group] of groupMap) {
    const questionStats: Record<string, QuestionStats> = {};
    const allQuestionNames = new Set<string>();

    for (const r of group.responses) {
      const resp = r.response as Record<string, unknown>;
      for (const key of Object.keys(resp)) {
        const n = extractNumericValue(resp, key);
        if (n !== null) allQuestionNames.add(key);
      }
    }

    const questionsToAnalyze = config
      ? Object.keys(config).filter((k) => config[k]?.includeInAnalytics !== false)
      : Array.from(allQuestionNames);

    if (questionsToAnalyze.length === 0 && group.responses.length > 0) {
      for (const r of group.responses) {
        Object.keys(r.response as Record<string, unknown>).forEach((k) => allQuestionNames.add(k));
      }
    }

    const allNumericKeys = new Set<string>();
    group.responses.forEach((r) => {
      const resp = r.response as Record<string, unknown>;
      Object.keys(resp).forEach((k) => {
        const n = extractNumericValue(resp, k);
        if (n !== null) allNumericKeys.add(k);
      });
    });

    const keysToUse = questionsToAnalyze.length > 0 ? questionsToAnalyze : Array.from(allNumericKeys);

    for (const qName of keysToUse) {
      const questionType = surveyJson ? getQuestionType(surveyJson, qName) : null;
      const values = group.responses
        .map((r) => extractNumericValue(r.response as Record<string, unknown>, qName))
        .filter((v): v is number => v !== null);

      const qConfig = config?.[qName];

      if (questionType === "checkbox") {
        const allSelections = group.responses
          .map((r) => extractCheckboxFlagValues(r.response as Record<string, unknown>, qName))
          .flat();
        const distribution: Record<number, number> = {};
        allSelections.forEach((v) => {
          distribution[v] = (distribution[v] ?? 0) + 1;
        });
        if (Object.keys(distribution).length > 0) {
          const responsesWithSelection = group.responses.filter((r) => {
            const vals = extractCheckboxFlagValues(r.response as Record<string, unknown>, qName);
            return vals.length > 0;
          }).length;
          questionStats[qName] = {
            mean: 0,
            median: 0,
            min: 0,
            max: 0,
            stdDev: 0,
            count: responsesWithSelection,
            distribution,
            deltaFromBaseline: 0
          };
        }
        continue;
      }

      if (qConfig?.flagValues) {
        const flagCounts = group.responses
          .map((r) => extractCheckboxFlagValues(r.response as Record<string, unknown>, qName))
          .flat()
          .filter((v) => qConfig.flagValues!.includes(v));

        if (flagCounts.length > 0) {
          questionStats[qName] = getDistributionWithDelta(
            { ...computeStats(values.length > 0 ? values : [0]), distribution: {} },
            0
          );
          questionStats[qName].count = flagCounts.length;
        }
      }

      if (values.length > 0) {
        const baseStats = computeStats(values);
        questionStats[qName] = getDistributionWithDelta(baseStats, 0);
      }
    }

    const memberCount = new Set(group.responses.map((r) => r.profile_id)).size;
    const responseCount = group.responses.length;
    const responseRate = memberCount > 0 ? responseCount / memberCount : 0;

    const groupStats: GroupAnalytics = {
      groupId,
      groupName: group.name,
      mentorId: group.mentorId,
      mentorName: group.mentorName,
      labSectionId: group.responses[0]?.lab_section_id ?? null,
      labSectionName: group.responses[0]?.lab_section_name ?? null,
      memberCount,
      responseCount,
      responseRate,
      questionStats,
      alerts: [],
      overallHealthScore: 0
    };

    groupStats.alerts = generateAlerts(groupStats, analyticsConfig);
    const alertScore = groupStats.alerts.reduce(
      (acc, a) => acc + (a.severity === "critical" ? 2 : a.severity === "warning" ? 1 : 0),
      0
    );
    groupStats.overallHealthScore = Math.max(0, 10 - alertScore);

    for (const [qName, stats] of Object.entries(groupStats.questionStats)) {
      const baseline = courseStats[qName]?.mean ?? stats.mean;
      stats.deltaFromBaseline = stats.mean - baseline;
    }

    groupAnalytics.push(groupStats);
  }

  return groupAnalytics;
}

function generateAlerts(groupStats: GroupAnalytics, analyticsConfig: SurveyAnalyticsConfig | null): Alert[] {
  const alerts: Alert[] = [];
  const varianceThreshold = analyticsConfig?.globalSettings?.varianceThreshold ?? 1.5;
  const nonResponseThreshold = analyticsConfig?.globalSettings?.nonResponseThreshold ?? 0.8;

  if (groupStats.responseRate < nonResponseThreshold && groupStats.memberCount > 0) {
    alerts.push({
      type: "non_response",
      severity: groupStats.responseRate < 0.5 ? "critical" : "warning",
      message: `Low response rate: ${Math.round(groupStats.responseRate * 100)}% (${groupStats.responseCount}/${groupStats.memberCount})`,
      threshold: nonResponseThreshold
    });
  }

  for (const [questionName, stats] of Object.entries(groupStats.questionStats)) {
    const config = analyticsConfig?.questions?.[questionName];
    if (!config?.alertThreshold || !config.alertMessage) continue;

    if (stats.stdDev > varianceThreshold) {
      alerts.push({
        type: "high_variance",
        severity: stats.stdDev > 2 ? "critical" : "warning",
        message: config.alertMessage,
        questionName,
        value: stats.stdDev,
        threshold: varianceThreshold
      });
    }

    if (config.alertDirection === "above" && stats.mean >= config.alertThreshold) {
      alerts.push({
        type: "low_score",
        severity: stats.mean - config.alertThreshold > 1 ? "critical" : "warning",
        message: config.alertMessage,
        questionName,
        value: stats.mean,
        threshold: config.alertThreshold
      });
    }
    if (config.alertDirection === "below" && stats.mean <= config.alertThreshold) {
      alerts.push({
        type: "low_score",
        severity: config.alertThreshold - stats.mean > 1 ? "critical" : "warning",
        message: config.alertMessage,
        questionName,
        value: stats.mean,
        threshold: config.alertThreshold
      });
    }
  }

  return alerts;
}

export function useSurveyAnalytics(
  surveyId: string | undefined,
  classId: number,
  analyticsConfig: SurveyAnalyticsConfig | null,
  options?: { selectedQuestions?: string[]; surveyJson?: Json }
) {
  const [responses, setResponses] = useState<SurveyResponseWithContext[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchResponses = useCallback(async () => {
    if (!surveyId || !classId) {
      setResponses([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: rpcError } = await supabase.rpc("get_survey_responses_with_full_context", {
        p_survey_id: surveyId,
        p_class_id: classId
      });
      if (rpcError) {
        setError(rpcError.message);
        setResponses([]);
      } else {
        setResponses((data as SurveyResponseWithContext[]) ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setResponses([]);
    } finally {
      setIsLoading(false);
    }
  }, [surveyId, classId]);

  useEffect(() => {
    fetchResponses();
  }, [fetchResponses]);

  return useMemo(() => {
    const surveyJson = options?.surveyJson ?? null;
    const submitted = responses.filter((r) => r.is_submitted);

    const ungrouped: SurveyResponseWithContext[] = submitted.filter((r) => !r.group_id || !r.group_name);

    const courseStats: Record<string, QuestionStats> = {};
    const allKeys = new Set<string>();
    submitted.forEach((r) => {
      const resp = r.response as Record<string, unknown>;
      Object.keys(resp).forEach((k) => {
        const v = resp[k];
        if (v !== null && v !== undefined) {
          if (typeof v === "number" && !isNaN(v)) allKeys.add(k);
          if (Array.isArray(v)) allKeys.add(k); // checkbox
        }
      });
    });

    for (const qName of allKeys) {
      const questionType = surveyJson ? getQuestionType(surveyJson, qName) : null;
      if (questionType === "checkbox") {
        const allSelections = submitted
          .map((r) => extractCheckboxFlagValues(r.response as Record<string, unknown>, qName))
          .flat();
        const distribution: Record<number, number> = {};
        allSelections.forEach((v) => {
          distribution[v] = (distribution[v] ?? 0) + 1;
        });
        if (Object.keys(distribution).length > 0) {
          const responsesWithSelection = submitted.filter((r) => {
            const vals = extractCheckboxFlagValues(r.response as Record<string, unknown>, qName);
            return vals.length > 0;
          }).length;
          courseStats[qName] = {
            mean: 0,
            median: 0,
            min: 0,
            max: 0,
            stdDev: 0,
            count: responsesWithSelection,
            distribution,
            deltaFromBaseline: 0
          };
        }
      } else {
        const values = submitted
          .map((r) => extractNumericValue(r.response as Record<string, unknown>, qName))
          .filter((v): v is number => v !== null);
        if (values.length > 0) {
          const baseStats = computeStats(values);
          courseStats[qName] = getDistributionWithDelta(baseStats, baseStats.mean);
        }
      }
    }

    const groupAnalytics = computeGroupAnalyticsFromResponses(submitted, surveyJson, analyticsConfig, courseStats);

    const sectionAnalytics: SectionAnalytics[] = [];
    const labSectionMap = new Map<number, SurveyResponseWithContext[]>();
    const classSectionMap = new Map<number, SurveyResponseWithContext[]>();
    submitted.forEach((r) => {
      if (r.lab_section_id) {
        const arr = labSectionMap.get(r.lab_section_id) ?? [];
        arr.push(r);
        labSectionMap.set(r.lab_section_id, arr);
      }
      if (r.class_section_id) {
        const arr = classSectionMap.get(r.class_section_id) ?? [];
        arr.push(r);
        classSectionMap.set(r.class_section_id, arr);
      }
    });

    labSectionMap.forEach((responses, sectionId) => {
      const sectionName = responses[0]?.lab_section_name ?? `Lab ${sectionId}`;
      const questionStats: Record<string, QuestionStats> = {};
      const allKeys = new Set<string>();
      responses.forEach((r) => {
        Object.keys(r.response as Record<string, unknown>).forEach((k) => allKeys.add(k));
      });
      for (const qName of allKeys) {
        const questionType = surveyJson ? getQuestionType(surveyJson, qName) : null;
        if (questionType === "checkbox") {
          const allSelections = responses
            .map((r) => extractCheckboxFlagValues(r.response as Record<string, unknown>, qName))
            .flat();
          const distribution: Record<number, number> = {};
          allSelections.forEach((v) => {
            distribution[v] = (distribution[v] ?? 0) + 1;
          });
          if (Object.keys(distribution).length > 0) {
            const responsesWithSelection = responses.filter((r) => {
              const vals = extractCheckboxFlagValues(r.response as Record<string, unknown>, qName);
              return vals.length > 0;
            }).length;
            questionStats[qName] = {
              mean: 0,
              median: 0,
              min: 0,
              max: 0,
              stdDev: 0,
              count: responsesWithSelection,
              distribution,
              deltaFromBaseline: 0
            };
          }
        } else {
          const values = responses
            .map((r) => extractNumericValue(r.response as Record<string, unknown>, qName))
            .filter((v): v is number => v !== null);
          if (values.length > 0) {
            const baseStats = computeStats(values);
            const baseline = courseStats[qName]?.mean ?? baseStats.mean;
            questionStats[qName] = getDistributionWithDelta(baseStats, baseline);
          }
        }
      }
      sectionAnalytics.push({
        sectionId,
        sectionName,
        sectionType: "lab",
        groupCount: new Set(responses.map((r) => r.group_id).filter(Boolean)).size,
        studentCount: new Set(responses.map((r) => r.profile_id)).size,
        responseCount: responses.length,
        questionStats
      });
    });

    classSectionMap.forEach((responses, sectionId) => {
      const sectionName = responses[0]?.class_section_name ?? `Section ${sectionId}`;
      const questionStats: Record<string, QuestionStats> = {};
      const allKeys = new Set<string>();
      responses.forEach((r) => {
        Object.keys(r.response as Record<string, unknown>).forEach((k) => allKeys.add(k));
      });
      for (const qName of allKeys) {
        const questionType = surveyJson ? getQuestionType(surveyJson, qName) : null;
        if (questionType === "checkbox") {
          const allSelections = responses
            .map((r) => extractCheckboxFlagValues(r.response as Record<string, unknown>, qName))
            .flat();
          const distribution: Record<number, number> = {};
          allSelections.forEach((v) => {
            distribution[v] = (distribution[v] ?? 0) + 1;
          });
          if (Object.keys(distribution).length > 0) {
            const responsesWithSelection = responses.filter((r) => {
              const vals = extractCheckboxFlagValues(r.response as Record<string, unknown>, qName);
              return vals.length > 0;
            }).length;
            questionStats[qName] = {
              mean: 0,
              median: 0,
              min: 0,
              max: 0,
              stdDev: 0,
              count: responsesWithSelection,
              distribution,
              deltaFromBaseline: 0
            };
          }
        } else {
          const values = responses
            .map((r) => extractNumericValue(r.response as Record<string, unknown>, qName))
            .filter((v): v is number => v !== null);
          if (values.length > 0) {
            const baseStats = computeStats(values);
            const baseline = courseStats[qName]?.mean ?? baseStats.mean;
            questionStats[qName] = getDistributionWithDelta(baseStats, baseline);
          }
        }
      }
      sectionAnalytics.push({
        sectionId,
        sectionName,
        sectionType: "class",
        groupCount: new Set(responses.map((r) => r.group_id).filter(Boolean)).size,
        studentCount: new Set(responses.map((r) => r.profile_id)).size,
        responseCount: responses.length,
        questionStats
      });
    });

    const allAlerts = groupAnalytics.flatMap((g) => g.alerts.map((a) => ({ ...a, groupName: g.groupName })));

    return {
      responses,
      isLoading,
      error,
      refetch: fetchResponses,
      courseStats,
      groupAnalytics,
      sectionAnalytics,
      alerts: allAlerts,
      totalResponses: submitted.length,
      ungroupedCount: ungrouped.length
    };
  }, [responses, isLoading, error, analyticsConfig, fetchResponses, options?.surveyJson]);
}

export type SurveyAnalyticsSnapshot = {
  courseStats: Record<string, QuestionStats>;
  sectionAnalytics: SectionAnalytics[];
  groupAnalytics: GroupAnalytics[];
  totalResponses: number;
};

/** Fetch analytics for multiple surveys in parallel (for series comparison) */
export function useSurveySeriesAnalytics(
  surveyIds: string[],
  classId: number,
  analyticsConfig: SurveyAnalyticsConfig | null,
  options?: { surveyJsonBySurveyId?: Record<string, Json> }
): {
  dataBySurveyId: Record<string, SurveyAnalyticsSnapshot>;
  isLoading: boolean;
  error: string | null;
} {
  const [responsesBySurvey, setResponsesBySurvey] = useState<Record<string, SurveyResponseWithContext[]>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!surveyIds.length || !classId) {
      setResponsesBySurvey({});
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    const supabase = createClient();
    Promise.all(
      surveyIds.map(async (sid) => {
        const { data, error: rpcError } = await supabase.rpc("get_survey_responses_with_full_context", {
          p_survey_id: sid,
          p_class_id: classId
        });
        if (rpcError) throw rpcError;
        return { surveyId: sid, responses: (data as SurveyResponseWithContext[]) ?? [] };
      })
    )
      .then((results) => {
        const map: Record<string, SurveyResponseWithContext[]> = {};
        results.forEach((r) => {
          map[r.surveyId] = r.responses.filter((x) => x.is_submitted);
        });
        setResponsesBySurvey(map);
      })
      .catch((e) => {
        setError(e?.message ?? "Failed to load");
        setResponsesBySurvey({});
      })
      .finally(() => setIsLoading(false));
  }, [surveyIds.join(","), classId]);

  return useMemo(() => {
    const dataBySurveyId: Record<string, SurveyAnalyticsSnapshot> = {};
    for (const surveyId of surveyIds) {
      const submitted = responsesBySurvey[surveyId] ?? [];
      const courseStats: Record<string, QuestionStats> = {};
      const allKeys = new Set<string>();
      submitted.forEach((r) => {
        const resp = r.response as Record<string, unknown>;
        Object.keys(resp).forEach((k) => {
          const v = resp[k];
          if (v !== null && v !== undefined) {
            if (typeof v === "number" && !isNaN(v)) allKeys.add(k);
            if (Array.isArray(v)) allKeys.add(k); // checkbox
          }
        });
      });
      for (const qName of allKeys) {
        const values = submitted
          .map((r) => extractNumericValue(r.response as Record<string, unknown>, qName))
          .filter((v): v is number => v !== null);
        if (values.length > 0) {
          const baseStats = computeStats(values);
          courseStats[qName] = getDistributionWithDelta(baseStats, baseStats.mean);
        } else {
          // Checkbox: count selections per choice
          const allSelections = submitted
            .map((r) => extractCheckboxFlagValues(r.response as Record<string, unknown>, qName))
            .flat();
          const distribution: Record<number, number> = {};
          allSelections.forEach((v) => {
            distribution[v] = (distribution[v] ?? 0) + 1;
          });
          if (Object.keys(distribution).length > 0) {
            const responsesWithSelection = submitted.filter((r) => {
              const vals = extractCheckboxFlagValues(r.response as Record<string, unknown>, qName);
              return vals.length > 0;
            }).length;
            courseStats[qName] = {
              mean: 0,
              median: 0,
              min: 0,
              max: 0,
              stdDev: 0,
              count: responsesWithSelection,
              distribution,
              deltaFromBaseline: 0
            };
          }
        }
      }
      const sectionAnalytics: SectionAnalytics[] = [];
      const labSectionMap = new Map<number, SurveyResponseWithContext[]>();
      const classSectionMap = new Map<number, SurveyResponseWithContext[]>();
      submitted.forEach((r) => {
        if (r.lab_section_id) {
          const arr = labSectionMap.get(r.lab_section_id) ?? [];
          arr.push(r);
          labSectionMap.set(r.lab_section_id, arr);
        }
        if (r.class_section_id) {
          const arr = classSectionMap.get(r.class_section_id) ?? [];
          arr.push(r);
          classSectionMap.set(r.class_section_id, arr);
        }
      });
      const addSection = (
        map: Map<number, SurveyResponseWithContext[]>,
        type: "lab" | "class",
        nameKey: "lab_section_name" | "class_section_name"
      ) => {
        map.forEach((responses, sectionId) => {
          const sectionName = responses[0]?.[nameKey] ?? `Section ${sectionId}`;
          const questionStats: Record<string, QuestionStats> = {};
          const keys = new Set<string>();
          responses.forEach((r) => Object.keys(r.response as Record<string, unknown>).forEach((k) => keys.add(k)));
          for (const qName of keys) {
            const values = responses
              .map((r) => extractNumericValue(r.response as Record<string, unknown>, qName))
              .filter((v): v is number => v !== null);
            if (values.length > 0) {
              const baseStats = computeStats(values);
              const baseline = courseStats[qName]?.mean ?? baseStats.mean;
              questionStats[qName] = getDistributionWithDelta(baseStats, baseline);
            } else {
              const allSelections = responses
                .map((r) => extractCheckboxFlagValues(r.response as Record<string, unknown>, qName))
                .flat();
              const distribution: Record<number, number> = {};
              allSelections.forEach((v) => {
                distribution[v] = (distribution[v] ?? 0) + 1;
              });
              if (Object.keys(distribution).length > 0) {
                const responsesWithSelection = responses.filter((r) => {
                  const vals = extractCheckboxFlagValues(r.response as Record<string, unknown>, qName);
                  return vals.length > 0;
                }).length;
                questionStats[qName] = {
                  mean: 0,
                  median: 0,
                  min: 0,
                  max: 0,
                  stdDev: 0,
                  count: responsesWithSelection,
                  distribution,
                  deltaFromBaseline: 0
                };
              }
            }
          }
          sectionAnalytics.push({
            sectionId,
            sectionName,
            sectionType: type,
            groupCount: new Set(responses.map((r) => r.group_id).filter(Boolean)).size,
            studentCount: new Set(responses.map((r) => r.profile_id)).size,
            responseCount: responses.length,
            questionStats
          });
        });
      };
      addSection(labSectionMap, "lab", "lab_section_name");
      addSection(classSectionMap, "class", "class_section_name");

      const surveyJson = options?.surveyJsonBySurveyId?.[surveyId] ?? null;
      const groupAnalytics = computeGroupAnalyticsFromResponses(submitted, surveyJson, analyticsConfig, courseStats);

      dataBySurveyId[surveyId] = {
        courseStats,
        sectionAnalytics,
        groupAnalytics,
        totalResponses: submitted.length
      };
    }
    return { dataBySurveyId, isLoading, error };
  }, [surveyIds, responsesBySurvey, isLoading, error, options?.surveyJsonBySurveyId]);
}
