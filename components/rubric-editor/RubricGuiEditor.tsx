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

  // Handle the "data loaded after mount" race: parts/criteria/checks ride on separate
  // list controllers and populate one render after the rubric row itself, so on first
  // mount the prop can be a hydrated rubric with empty rubric_parts even though the
  // rubric has parts in the DB. Without this catch-up, useState would latch on the
  // empty initial prop and the GUI would stay empty after the data arrives.
  //
  // We only fire when the local draft is still empty (the latch case). Once the user has
  // any parts in draft (either freshly loaded or because they made edits), we leave the
  // draft alone: user edits are king, and triggering setDraft on every parent reference
  // change would cause spurious re-renders that detach DOM mid-action in e2e tests.
  useEffect(() => {
    if (draftRef.current.rubric_parts.length > 0) return;
    if (rubric.rubric_parts.length === 0) return;
    if (commitTimeoutRef.current) return;
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
