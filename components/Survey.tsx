"use client";

import { Model } from "survey-core";
import { Survey, PopupSurvey } from "survey-react-ui";
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
  // Create survey model from JSON
  const survey = new Model(surveyJson);

  // Set initial data if provided
  if (initialData) {
    survey.data = initialData;
  }

  // Set read-only mode if specified
  if (readOnly) {
    survey.mode = "display";
  }

  // Set up event handlers
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
