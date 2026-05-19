"use client";

import { RubricEditorTree, type ReferenceEditorContext } from "@/components/rubric-editor/RubricEditorTree";
import { validateRubric, type ValidationError } from "@/components/rubric-editor/validation";
import { HydratedRubric } from "@/utils/supabase/DatabaseTypes";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

const GUI_COMMIT_DEBOUNCE_MS = 400;
const GUI_VALIDATE_DEBOUNCE_MS = 400;

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
  const validateTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>(() => validateRubric(rubric));

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
    draftRef.current = rubric;
    setDraft(rubric);
    if (validateTimeoutRef.current) {
      clearTimeout(validateTimeoutRef.current);
      validateTimeoutRef.current = undefined;
    }
    setValidationErrors(validateRubric(rubric));
  }, [rubric]);

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
      draftRef.current = next;
      setDraft(next);
      onDraftActivity?.(next);

      if (validateTimeoutRef.current) clearTimeout(validateTimeoutRef.current);
      validateTimeoutRef.current = setTimeout(() => {
        validateTimeoutRef.current = undefined;
        setValidationErrors(validateRubric(next));
      }, GUI_VALIDATE_DEBOUNCE_MS);

      scheduleCommit(next);
    },
    [onDraftActivity, scheduleCommit]
  );

  useImperativeHandle(
    ref,
    () => ({
      flushDraft: () => {
        if (commitTimeoutRef.current) {
          clearTimeout(commitTimeoutRef.current);
          commitTimeoutRef.current = undefined;
        }
        if (validateTimeoutRef.current) {
          clearTimeout(validateTimeoutRef.current);
          validateTimeoutRef.current = undefined;
        }
        const current = draftRef.current;
        if (current) {
          setValidationErrors(validateRubric(current));
        }
        return current;
      }
    }),
    []
  );

  useEffect(() => {
    return () => {
      if (commitTimeoutRef.current) clearTimeout(commitTimeoutRef.current);
      if (validateTimeoutRef.current) clearTimeout(validateTimeoutRef.current);
    };
  }, []);

  return (
    <RubricEditorTree
      rubric={draft}
      onChange={handleChange}
      validationErrors={validationErrors}
      assignmentMaxPoints={assignmentMaxPoints}
      autograderPoints={autograderPoints}
      referenceContext={referenceContext}
    />
  );
});
