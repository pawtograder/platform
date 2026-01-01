"use client";

import { useEffect, useMemo } from "react";
import { Model, ValueChangedEvent } from "survey-core";
import { Survey, PopupSurvey } from "survey-react-ui";
import { useColorMode } from "@/components/ui/color-mode";
import { DefaultDark, DefaultLight } from "survey-core/themes";
import "survey-core/survey-core.css";
import { Json } from "@/utils/supabase/SupabaseTypes";

interface SurveyComponentProps {
  surveyJson: Json;
  isPopup?: boolean;
  isExpanded?: boolean;
  onComplete?: (survey: Model) => void;
  onValueChanged?: (survey: Model, options: ValueChangedEvent) => void;
  initialData?: Json;
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
  const { colorMode } = useColorMode();

  const survey = useMemo(() => new Model(surveyJson), [surveyJson]);

  useEffect(() => {
    if (colorMode === "dark") {
      survey.applyTheme(DefaultDark);
    } else {
      survey.applyTheme(DefaultLight);
    }
  }, [colorMode, survey]);

  useEffect(() => {
    if (initialData !== undefined) {
      survey.data = initialData;
    }
  }, [initialData, survey]);

  useEffect(() => {
    survey.readOnly = !!readOnly;
  }, [readOnly, survey]);

  useEffect(() => {
    if (!onComplete) return;
    survey.onComplete.add(onComplete);
    return () => {
      survey.onComplete.remove(onComplete);
    };
  }, [onComplete, survey]);

  useEffect(() => {
    if (!onValueChanged) return;
    survey.onValueChanged.add(onValueChanged);
    return () => {
      survey.onValueChanged.remove(onValueChanged);
    };
  }, [onValueChanged, survey]);

  // Render the survey in a pop-up window
  if (isPopup) {
    return <PopupSurvey model={survey} isExpanded={isExpanded} />;
  }

  // Render the survey inside the page
  return <Survey model={survey} />;
}
