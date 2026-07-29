"use client";

import { useEffect, useMemo, useRef } from "react";
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

  // The survey definition reaches us as a JSONB column on a row owned by a
  // TableController, so its object identity changes on any realtime update or
  // refetch even when the definition is byte-identical. Keying the model on
  // identity meant a no-op refetch rebuilt the entire question tree —
  // remounting every input and throwing away focus and the screen-reader
  // cursor. Key on content instead (issue #881). The model is then built from
  // the parsed key rather than from `surveyJson` so the memo's dependency stays
  // honest — the definition is JSONB, so round-tripping it is lossless.
  const surveyJsonKey = useMemo(() => JSON.stringify(surveyJson ?? null), [surveyJson]);

  const survey = useMemo(() => {
    const model = new Model(JSON.parse(surveyJsonKey));
    // Accessibility tuning (WCAG 1.3.2 Meaningful Sequence + 1.3.1 Info &
    // Relationships): SurveyJS defaults auto-focus the first answer, which
    // causes VoiceOver to read the choice list before the question prompt.
    // Force the title above the inputs, render titles as real h2 headings
    // so AT can navigate to them, and stop the auto-focus so the question
    // is read in document order.
    model.questionTitleLocation = "top";
    model.focusFirstQuestionAutomatic = false;
    // Commit text answers to the model as they are typed instead of on blur.
    // Under the SurveyJS default ("onBlur") text that has been typed but not
    // blurred exists only in the DOM input: it is outside `survey.data`, so it
    // is never autosaved, and any model→DOM sync overwrites it (SurveyJS text
    // inputs are uncontrolled and get written back imperatively by
    // `updateDomElement`). Screen-reader users routinely move off a field with
    // AT navigation rather than a blur the model acts on, which made required
    // text questions effectively impossible to complete (issue #881).
    model.textUpdateMode = "onTyping";
    // SurveyJS renders titles as <div> by default (settings.titleTags.question);
    // onGetTitleTagName is the supported per-survey override. (A plain
    // `questionTitleTagName` assignment is NOT a SurveyJS API and does nothing.)
    model.onGetTitleTagName.add((_sender, options) => {
      if ((options.element as { isQuestion?: boolean }).isQuestion) {
        options.tagName = "h2";
      }
    });
    return model;
  }, [surveyJsonKey]);

  useEffect(() => {
    if (colorMode === "dark") {
      survey.applyTheme(DefaultDark);
    } else {
      survey.applyTheme(DefaultLight);
    }
  }, [colorMode, survey]);

  // Applying `initialData` is destructive: survey-core's `data` setter wipes
  // `valuesHash` and re-seeds every question, and because text inputs are
  // uncontrolled SurveyJS then writes the model value straight into the live
  // DOM node. Two guards keep that from eating the user's answers (issue #881):
  //
  //  1. A value-equal draft must be a no-op. `initialData` is a fresh object on
  //     every refetch, so an identity-keyed effect re-applied the same draft
  //     and silently replaced whatever was in the focused field.
  //  2. Once the user has edited anything, the saved draft is by definition
  //     behind them, so a late-arriving one must never win. This is the race
  //     the page hits on load: the survey renders before the student's saved
  //     response has been fetched, so answers given in that window would be
  //     overwritten when it lands.
  //
  // Read-only renderers (staff viewing a submitted response) are exempt from
  // guard 2 — there are no local edits to protect and the viewer legitimately
  // swaps between responses.
  const appliedDataKeyRef = useRef<string | null>(null);
  const hasLocalEditsRef = useRef(false);

  // Reset the guards when the model itself is replaced. Declared before the
  // effects below so it runs first on a model swap.
  useEffect(() => {
    appliedDataKeyRef.current = null;
    hasLocalEditsRef.current = false;
  }, [survey]);

  useEffect(() => {
    const markEdited = () => {
      hasLocalEditsRef.current = true;
    };
    survey.onValueChanged.add(markEdited);
    return () => {
      survey.onValueChanged.remove(markEdited);
    };
  }, [survey]);

  useEffect(() => {
    if (initialData === undefined) return;
    const dataKey = JSON.stringify(initialData);
    if (dataKey === appliedDataKeyRef.current) return;
    if (hasLocalEditsRef.current && !readOnly) return;
    appliedDataKeyRef.current = dataKey;
    survey.data = initialData;
  }, [initialData, survey, readOnly]);

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
