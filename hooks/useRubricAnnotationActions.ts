"use client";

import { isRubricCheckDataWithOptions, RubricCheckSubOption } from "@/components/ui/code-file-shared";
import { useRubricChecksByRubric, useRubricCriteriaByRubric, useRubricWithParts } from "@/hooks/useAssignment";
import { useSubmissionFileComments } from "@/hooks/useSubmission";
import { useDefaultWritableSubmissionReview } from "@/hooks/useSubmissionReview";
import { RubricCheck, RubricCriteria, SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { useMemo } from "react";

/** A single applicable rubric annotation action (a check, or one sub-option of a check). */
export type RubricContextMenuAction = {
  id: string;
  label: string;
  criteria?: RubricCriteria;
  check?: RubricCheck;
  subOption?: RubricCheckSubOption;
  isCommentAction?: boolean;
};

/**
 * Builds the list of applicable annotation actions for a file from the active review's rubric.
 *
 * Single source of truth shared by every line-annotation surface (the Monaco context menu, the plain
 * line menu, and the keyboard quick-apply palette) so the `max_annotations` cap, sub-option expansion,
 * and criteria grouping behave identically everywhere. A check that has reached its `max_annotations`
 * is omitted.
 *
 * Only checks from the default writable review's rubric are offered: graders should apply checks to a
 * review they can actually write to, never to a read-only one. We prefer the active review when it is
 * writable, otherwise fall back to the first writable review (the same default the workspace uses).
 */
export function useRubricAnnotationActions(file: SubmissionFile | null) {
  const review = useDefaultWritableSubmissionReview();
  const rubric = useRubricWithParts(review?.rubric_id);
  const rubricCriteria = useRubricCriteriaByRubric(rubric?.id);
  const rubricChecks = useRubricChecksByRubric(rubric?.id);
  const existingComments = useSubmissionFileComments({ file_id: file?.id ?? 0 });

  const menuActions = useMemo<RubricContextMenuAction[]>(() => {
    if (!rubricCriteria || !rubricChecks || !file) {
      return [];
    }

    const actions: RubricContextMenuAction[] = [];

    const annotationChecks = rubricChecks.filter(
      (check: RubricCheck) =>
        check.is_annotation && (check.annotation_target === "file" || check.annotation_target === null)
    );

    // Order criteria exactly as the rubric sidebar does: by rubric-part ordinal, then by the
    // criteria's ordinal within its part (criteria ordinals are part-scoped, so a global ordinal sort
    // would interleave parts).
    const partOrdinalById = new Map((rubric?.rubric_parts ?? []).map((p) => [p.id, p.ordinal]));
    const criteriaWithChecks = rubricCriteria
      .filter((criteria: RubricCriteria) =>
        annotationChecks.some((check: RubricCheck) => check.rubric_criteria_id === criteria.id)
      )
      .sort(
        (a, b) =>
          (partOrdinalById.get(a.rubric_part_id) ?? 0) - (partOrdinalById.get(b.rubric_part_id) ?? 0) ||
          a.ordinal - b.ordinal
      );

    criteriaWithChecks.forEach((criteria: RubricCriteria) => {
      const checksForCriteria = annotationChecks
        .filter((check: RubricCheck) => check.rubric_criteria_id === criteria.id)
        .sort((a, b) => a.ordinal - b.ordinal);

      checksForCriteria.forEach((check: RubricCheck) => {
        const existingAnnotationsForCheck = existingComments.filter(
          (comment) => comment.rubric_check_id === check.id
        ).length;
        const atMax = check.max_annotations ? existingAnnotationsForCheck >= check.max_annotations : false;
        if (atMax) return;

        if (isRubricCheckDataWithOptions(check.data)) {
          check.data.options.forEach((subOption: RubricCheckSubOption, index: number) => {
            actions.push({
              id: `check-${check.id}-sub-${index}`,
              label: `${criteria.is_additive ? "+" : "-"}${subOption.points} ${subOption.label}`,
              criteria,
              check,
              subOption
            });
          });
        } else {
          const pointsText = check.points ? ` (${criteria.is_additive ? "+" : "-"}${check.points} pts)` : "";
          actions.push({
            id: `check-${check.id}`,
            label: `${check.name}${pointsText}`,
            criteria,
            check
          });
        }
      });
    });

    return actions;
  }, [rubricCriteria, rubricChecks, file, existingComments, rubric?.rubric_parts]);

  const actionsByCriteria = useMemo(() => {
    const map = new Map<number, RubricContextMenuAction[]>();
    menuActions.forEach((action) => {
      if (!action.criteria) return;
      const id = action.criteria.id;
      if (!map.has(id)) map.set(id, []);
      map.get(id)!.push(action);
    });
    return map;
  }, [menuActions]);

  return { menuActions, actionsByCriteria, rubricCriteria };
}
