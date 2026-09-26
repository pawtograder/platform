"use client";

import React, { useEffect, useMemo, useRef } from "react";
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

  // Callers pass inline arrow functions, so the handler identities change on every
  // render. Keep them in refs and register one stable listener per model: re-registering
  // on each render would stack duplicate listeners on a memoized model, and including the
  // handlers in the memo dependencies would rebuild the model on every render and throw
  // away whatever state the respondent had built up.
  const onCompleteRef = useRef(onComplete);
  const onValueChangedRef = useRef(onValueChanged);
  useEffect(() => {
    onCompleteRef.current = onComplete;
    onValueChangedRef.current = onValueChanged;
  }, [onComplete, onValueChanged]);

  // A `Model` is expensive and stateful, so build it once per (json, data, theme,
  // read-only) combination rather than on every render. Stacking one of these per group
  // member on the submission survey tab makes the difference visible.
  const survey = useMemo(() => {
    const model = new Model(surveyJson);

    // Apply SurveyJS theme based on color mode
    model.applyTheme(colorMode === "dark" ? DefaultDark : DefaultLight);

    // Set initial data FIRST, before setting other properties
    if (responseData) {
      model.data = responseData;
    }

    // Set read-only mode if specified
    if (readOnly) {
      model.readOnly = true;
    }

    // Set up event handlers AFTER setting data and read-only mode
    model.onComplete.add((sender, options) => onCompleteRef.current?.(sender, options));
    model.onValueChanged.add((sender, options) => onValueChangedRef.current?.(sender, options));

    return model;
  }, [surveyJson, responseData, colorMode, readOnly]);

  return <Survey model={survey} />;
}
