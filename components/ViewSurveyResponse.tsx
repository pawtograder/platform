"use client";

import React from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import { useColorMode } from "@/components/ui/color-mode";
import { DefaultDark, DefaultLight } from "survey-core/themes";
import "survey-core/survey-core.min.css";
import type { Survey as SurveyType, SurveyResponseWithProfile } from "@/types/survey";

interface ViewSurveyResponseProps {
  surveyJson: SurveyType["json"];
  responseData: SurveyResponseWithProfile["response"];
  readOnly?: boolean;
  onComplete?: (sender: Model, options: unknown) => void;
  onValueChanged?: (sender: Model, options: unknown) => void;
}

export default function ViewSurveyResponse({
  surveyJson,
  responseData,
  readOnly = true,
  onComplete,
  onValueChanged
}: ViewSurveyResponseProps) {
  // Get color mode to determine theme
  const { colorMode } = useColorMode();

  // Create survey model from JSON
  const survey = new Model(surveyJson);

  // Apply SurveyJS theme based on color mode
  if (colorMode === "dark") {
    survey.applyTheme(DefaultDark);
  } else {
    survey.applyTheme(DefaultLight);
  }

  // Set initial data FIRST, before setting other properties
  if (responseData) {
    survey.data = responseData;
  }

  // Set read-only mode if specified
  if (readOnly) {
    survey.readOnly = true;
  }

  // Set up event handlers AFTER setting data and read-only mode
  if (onComplete) {
    survey.onComplete.add(onComplete);
  }

  if (onValueChanged) {
    survey.onValueChanged.add(onValueChanged);
  }

  return <Survey model={survey} />;
}
