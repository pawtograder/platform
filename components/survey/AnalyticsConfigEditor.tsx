"use client";

import type { QuestionAnalyticsConfig, SurveyAnalyticsConfig } from "@/types/survey-analytics";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { Switch } from "@/components/ui/switch";
import { Card, Field, HStack, Input, NativeSelect, Stack, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";
import { Model } from "survey-core";

type AnalyticsConfigEditorProps = {
  surveyJson: Json;
  analyticsConfig: SurveyAnalyticsConfig;
  onChange: (config: SurveyAnalyticsConfig) => void;
};

function getQuestionsFromSurvey(surveyJson: Json): { name: string; title: string; type: string }[] {
  const questions: { name: string; title: string; type: string }[] = [];
  try {
    const survey = new Model(surveyJson);
    survey.getAllQuestions().forEach((q) => {
      if (q.name) {
        questions.push({
          name: q.name,
          title: q.title || q.name,
          type: q.getType()
        });
      }
    });
  } catch {
    /* ignore */
  }
  return questions;
}

export function AnalyticsConfigEditor({ surveyJson, analyticsConfig, onChange }: AnalyticsConfigEditorProps) {
  const questions = useMemo(() => getQuestionsFromSurvey(surveyJson), [surveyJson]);

  const updateQuestionConfig = (questionName: string, updates: Partial<QuestionAnalyticsConfig>) => {
    onChange({
      ...analyticsConfig,
      questions: {
        ...analyticsConfig.questions,
        [questionName]: {
          ...(analyticsConfig.questions[questionName] ?? { includeInAnalytics: false }),
          ...updates
        }
      }
    });
  };

  const updateGlobalSettings = (updates: Partial<SurveyAnalyticsConfig["globalSettings"]>) => {
    onChange({
      ...analyticsConfig,
      globalSettings: {
        ...analyticsConfig.globalSettings,
        ...updates
      }
    });
  };

  return (
    <VStack align="stretch" gap={6}>
      <Card.Root>
        <Card.Header>
          <Text fontWeight="semibold">Global Alert Thresholds</Text>
        </Card.Header>
        <Card.Body>
          <Stack spaceY={4}>
            <Field.Root>
              <Field.Label>Variance Threshold</Field.Label>
              <Input
                type="number"
                step="0.1"
                value={analyticsConfig.globalSettings?.varianceThreshold ?? 1.5}
                onChange={(e) =>
                  updateGlobalSettings({
                    varianceThreshold: parseFloat(e.target.value) || 1.5
                  })
                }
              />
              <Field.HelperText>Standard deviation above which to flag high variance</Field.HelperText>
            </Field.Root>
            <Field.Root>
              <Field.Label>Non-Response Threshold (%)</Field.Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={((analyticsConfig.globalSettings?.nonResponseThreshold ?? 0.8) * 100).toFixed(0)}
                onChange={(e) =>
                  updateGlobalSettings({
                    nonResponseThreshold: (parseFloat(e.target.value) || 80) / 100
                  })
                }
              />
              <Field.HelperText>Response rate below which to flag groups</Field.HelperText>
            </Field.Root>
          </Stack>
        </Card.Body>
      </Card.Root>

      <Text fontWeight="semibold">Per-Question Configuration</Text>
      {questions.map((q) => {
        const config = analyticsConfig.questions[q.name] ?? { includeInAnalytics: false };
        return (
          <Card.Root key={q.name}>
            <Card.Header>
              <HStack justify="space-between">
                <Text fontWeight="medium" fontSize="sm">
                  {q.title}
                </Text>
                <HStack>
                  <Text fontSize="sm" color="fg.muted">
                    Include
                  </Text>
                  <Switch
                    checked={config.includeInAnalytics}
                    onCheckedChange={(e: { checked: boolean }) =>
                      updateQuestionConfig(q.name, { includeInAnalytics: e.checked })
                    }
                  />
                </HStack>
              </HStack>
            </Card.Header>
            {config.includeInAnalytics && (
              <Card.Body>
                <Stack spaceY={3}>
                  <Field.Root>
                    <Field.Label>Alert Threshold</Field.Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={config.alertThreshold ?? ""}
                      onChange={(e) =>
                        updateQuestionConfig(q.name, {
                          alertThreshold: e.target.value ? parseFloat(e.target.value) : undefined
                        })
                      }
                      placeholder="Value that triggers alert"
                    />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Alert Direction</Field.Label>
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        value={config.alertDirection ?? "above"}
                        onChange={(e) =>
                          updateQuestionConfig(q.name, {
                            alertDirection: e.target.value as QuestionAnalyticsConfig["alertDirection"]
                          })
                        }
                      >
                        <option value="above">Above threshold (mean)</option>
                        <option value="below">Below threshold (mean)</option>
                        <option value="any_above">Any response above threshold</option>
                        <option value="any_below">Any response below threshold</option>
                      </NativeSelect.Field>
                    </NativeSelect.Root>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Alert Message</Field.Label>
                    <Input
                      value={config.alertMessage ?? ""}
                      onChange={(e) => updateQuestionConfig(q.name, { alertMessage: e.target.value || undefined })}
                      placeholder="e.g., Team reports lower than expected progress"
                    />
                  </Field.Root>
                  <HStack>
                    <Switch
                      checked={config.isReversedScale ?? false}
                      onCheckedChange={(e: { checked: boolean }) =>
                        updateQuestionConfig(q.name, { isReversedScale: e.checked })
                      }
                    />
                    <Text fontSize="sm">Reversed scale (higher value = worse outcome)</Text>
                  </HStack>
                </Stack>
              </Card.Body>
            )}
          </Card.Root>
        );
      })}
    </VStack>
  );
}
