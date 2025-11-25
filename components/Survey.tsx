"use client";

import { Model } from "survey-core";
import { Survey, PopupSurvey } from "survey-react-ui";
import { useColorModeValue } from "@/components/ui/color-mode";
import { DefaultDark, DefaultLight } from "survey-core/themes";
import "survey-core/survey-core.css";

interface SurveyComponentProps {
  surveyJson: any;
  isPopup?: boolean;
  isExpanded?: boolean;
  onComplete?: (survey: Model) => void;
  onValueChanged?: (survey: Model, options: any) => void;
  initialData?: any;
  readOnly?: boolean;
}

export default function SurveyComponent({
  surveyJson,
  isPopup = false,
  isExpanded = true,
  onComplete,
  onValueChanged,
  initialData,
  readOnly = false
}: SurveyComponentProps) {
  // Get color mode to determine theme
  const isDarkMode = useColorModeValue(false, true);

  // Create survey model from JSON
  const survey = new Model(surveyJson);

  // Apply SurveyJS theme based on color mode
  if (isDarkMode) {
    survey.applyTheme(DefaultDark);
  } else {
    survey.applyTheme(DefaultLight);
  }

  // Set initial data FIRST, before setting other properties
  if (initialData) {
    survey.data = initialData;
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

  // Render the survey in a pop-up window
  if (isPopup) {
    return <PopupSurvey model={survey} isExpanded={isExpanded} />;
  }

  // Render the survey inside the page
  return <Survey model={survey} />;
}
