"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { Text } from "@chakra-ui/react";
import { Model } from "survey-core";
import { Survey, SurveyElementBase } from "survey-react-ui";
import { useColorMode } from "@/components/ui/color-mode";
import { DefaultDark, DefaultLight } from "survey-core/themes";
import "survey-core/survey-core.min.css";
import type { Survey as SurveyType, SurveyResponseWithProfile } from "@/types/survey";

interface ViewSurveyResponseProps {
  surveyJson: SurveyType["json"];
  responseData: SurveyResponseWithProfile["response"];
  /**
   * The description the caller already shows next to its heading, if any. The survey's
   * JSON description is shown above the response unless it says the same thing.
   */
  shownDescription?: string | null;
  readOnly?: boolean;
  onComplete?: (sender: Model, options: unknown) => void;
  onValueChanged?: (sender: Model, options: unknown) => void;
}

export default function ViewSurveyResponse({
  surveyJson,
  responseData,
  shownDescription,
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
    // Every caller shows the survey's database title as its own heading, so the
    // renderer shows none: a second copy repeated it once per response, and the JSON
    // title is often the builder's "Survey Name" placeholder (issue #1002). SurveyJS
    // shows the description only alongside the title, so it is rendered separately.
    model.showTitle = false;

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

  // SurveyJS's own string for the description, so locales and {placeholders} come out
  // as they do for the student. Plain text, not a heading: the caller has the heading.
  const showDescription = survey.hasDescription && survey.description.trim() !== (shownDescription ?? "").trim();

  return (
    <>
      {showDescription && <Text mb={2}>{SurveyElementBase.renderLocString(survey.locDescription)}</Text>}
      <Survey model={survey} />
    </>
  );
}
