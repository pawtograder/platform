"use client";

import { RubricEditorTree, type ReferenceEditorContext } from "@/components/rubric-editor/RubricEditorTree";
import { validateRubric, type ValidationError, type ValidationWarning } from "@/components/rubric-editor/validation";
import { sanitizeHydratedRubricPoints } from "@/lib/rubric/pointsSanitize";
import { HydratedRubric } from "@/utils/supabase/DatabaseTypes";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

const GUI_COMMIT_DEBOUNCE_MS = 400;

export type RubricGuiEditorHandle = {
  /** Returns the current draft and cancels any pending debounced commit. */
  flushDraft: () => HydratedRubric | undefined;
};

type RubricGuiEditorProps = {
  rubric: HydratedRubric;
  onCommit: (rubric: HydratedRubric) => void;
  onDraftActivity?: (rubric: HydratedRubric) => void;
  assignmentMaxPoints: number;
  autograderPoints: number;
  referenceContext?: ReferenceEditorContext;
};

/**
 * Holds rubric draft state locally so keystrokes do not re-render the parent page
 * (Monaco, sidebar preview, points summary, etc.). Commits to the parent on a debounce.
 */
export const RubricGuiEditor = forwardRef<RubricGuiEditorHandle, RubricGuiEditorProps>(function RubricGuiEditor(
  { rubric, onCommit, onDraftActivity, assignmentMaxPoints, autograderPoints, referenceContext },
  ref
) {
  const [draft, setDraft] = useState(rubric);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const commitTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>(() => validateRubric(rubric));
  const [validationWarnings, setValidationWarnings] = useState<ValidationWarning[]>([]);

  const applySanitizedDraft = useCallback((next: HydratedRubric) => {
    const { rubric: sanitized, warnings } = sanitizeHydratedRubricPoints(next);
    draftRef.current = sanitized;
    setDraft(sanitized);
    setValidationWarnings(warnings);
    setValidationErrors(validateRubric(sanitized));
    return sanitized;
  }, []);

  // Sync the parent's rubric into our local draft when it changes externally.
  // Parts/criteria/checks ride on separate list controllers and populate in a
  // second render after the rubric row itself, so the initial prop can be a
  // hydrated rubric with empty rubric_parts even though the rubric has parts
  // in the database. Without this effect, useState would latch onto the empty
  // first prop and the GUI would stay empty even after the data arrives.
  // Skip the sync while a commit is pending so we don't clobber in-flight edits.
  const lastAcceptedRubricRef = useRef(rubric);
  useEffect(() => {
    if (rubric === lastAcceptedRubricRef.current) return;
    if (commitTimeoutRef.current) {
      lastAcceptedRubricRef.current = rubric;
      return;
    }
    lastAcceptedRubricRef.current = rubric;
    applySanitizedDraft(rubric);
  }, [rubric, applySanitizedDraft]);

  const scheduleCommit = useCallback(
    (next: HydratedRubric) => {
      if (commitTimeoutRef.current) clearTimeout(commitTimeoutRef.current);
      commitTimeoutRef.current = setTimeout(() => {
        commitTimeoutRef.current = undefined;
        onCommit(next);
      }, GUI_COMMIT_DEBOUNCE_MS);
    },
    [onCommit]
  );

  const handleChange = useCallback(
    (next: HydratedRubric) => {
      const sanitized = applySanitizedDraft(next);
      onDraftActivity?.(sanitized);
      scheduleCommit(sanitized);
    },
    [applySanitizedDraft, onDraftActivity, scheduleCommit]
  );

  useImperativeHandle(
    ref,
    () => ({
      flushDraft: () => {
        if (commitTimeoutRef.current) {
          clearTimeout(commitTimeoutRef.current);
          commitTimeoutRef.current = undefined;
        }
        return draftRef.current;
      }
    }),
    []
  );

  useEffect(() => {
    return () => {
      if (commitTimeoutRef.current) clearTimeout(commitTimeoutRef.current);
    };
  }, []);

  return (
    <RubricEditorTree
      rubric={draft}
      onChange={handleChange}
      validationErrors={validationErrors}
      validationWarnings={validationWarnings}
      assignmentMaxPoints={assignmentMaxPoints}
      autograderPoints={autograderPoints}
      referenceContext={referenceContext}
    />
  );
});
