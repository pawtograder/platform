"use client";

import { useRubricChecksByRubric, useRubricCriteriaByRubric, useRubricWithParts } from "@/hooks/useAssignment";
import { useSubmissionFileComments } from "@/hooks/useSubmission";
import { useActiveSubmissionReview } from "@/hooks/useSubmissionReview";
import { RubricCheck, RubricCriteria, SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, HStack, Text, VStack } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { isRubricCheckDataWithOptions, RubricCheckSubOption } from "./code-file-shared";
import { RubricContextMenuAction } from "./monaco-rubric-context-menu";
import { RubricQuickPick } from "./rubric-quick-pick";

type PlainRubricLineMenuProps = {
  file: SubmissionFile;
  lineNumber: number;
  onSelectCheck: (action: RubricContextMenuAction, startLine: number, endLine: number) => void;
  onImmediateApply: (action: RubricContextMenuAction, startLine: number, endLine: number) => void;
  onAddComment: (startLine: number, endLine: number) => void;
};

/**
 * Line-level rubric actions for the plain (non-Monaco) grading view.
 * Reuses the same rubric structure as the Monaco context menu without registering editor actions.
 */
export function PlainRubricLineMenu({
  file,
  lineNumber,
  onSelectCheck,
  onImmediateApply,
  onAddComment
}: PlainRubricLineMenuProps) {
  const review = useActiveSubmissionReview();
  const rubric = useRubricWithParts(review?.rubric_id);
  const rubricCriteria = useRubricCriteriaByRubric(rubric?.id);
  const rubricChecks = useRubricChecksByRubric(rubric?.id);
  const existingComments = useSubmissionFileComments({ file_id: file.id });

  const [quickPickState, setQuickPickState] = useState<{
    isOpen: boolean;
    title: string;
    items: RubricContextMenuAction[];
  }>({ isOpen: false, title: "", items: [] });

  const [applyQuickPickState, setApplyQuickPickState] = useState<{
    isOpen: boolean;
    action: RubricContextMenuAction | null;
  }>({ isOpen: false, action: null });

  const menuActions = useMemo(() => {
    if (!rubricCriteria || !rubricChecks || !file) {
      return [];
    }

    const actions: RubricContextMenuAction[] = [];

    const annotationChecks = rubricChecks.filter(
      (check: RubricCheck) =>
        check.is_annotation && (check.annotation_target === "file" || check.annotation_target === null)
    );

    const criteriaWithChecks = rubricCriteria
      .filter((criteria: RubricCriteria) =>
        annotationChecks.some((check: RubricCheck) => check.rubric_criteria_id === criteria.id)
      )
      .sort((a, b) => a.ordinal - b.ordinal);

    criteriaWithChecks.forEach((criteria: RubricCriteria) => {
      const checksForCriteria = annotationChecks
        .filter((check: RubricCheck) => check.rubric_criteria_id === criteria.id)
        .sort((a, b) => a.ordinal - b.ordinal);

      checksForCriteria.forEach((check: RubricCheck) => {
        const existingAnnotationsForCheck = existingComments.filter(
          (comment) => comment.rubric_check_id === check.id
        ).length;
        const isDisabled = check.max_annotations ? existingAnnotationsForCheck >= check.max_annotations : false;
        if (isDisabled) return;

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
  }, [rubricCriteria, rubricChecks, file, existingComments]);

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

  const handleQuickPickSelect = (action: RubricContextMenuAction) => {
    const startLine = lineNumber;
    const endLine = lineNumber;

    if (action.check?.is_comment_required) {
      onSelectCheck(action, startLine, endLine);
      return;
    }

    setApplyQuickPickState({ isOpen: true, action });
  };

  const handleApplyQuickPickSelect = (option: "apply" | "apply-with-comment") => {
    const action = applyQuickPickState.action;
    if (!action) return;
    const startLine = lineNumber;
    const endLine = lineNumber;

    if (option === "apply") {
      onImmediateApply(action, startLine, endLine);
    } else {
      onSelectCheck(action, startLine, endLine);
    }
    setApplyQuickPickState({ isOpen: false, action: null });
  };

  if (!rubricCriteria || menuActions.length === 0) {
    return null;
  }

  return (
    <>
      <Box borderTop="1px solid" borderColor="border.emphasized" bg="bg.subtle" py={1} px={2} fontSize="xs">
        <Text color="text.subtle" mb={1}>
          Line {lineNumber}
        </Text>
        <VStack align="stretch" gap={1}>
          <Button size="xs" variant="outline" onClick={() => onAddComment(lineNumber, lineNumber)}>
            Add comment…
          </Button>
          {Array.from(actionsByCriteria.entries()).map(([criteriaId, actions]) => {
            const criteria = actions[0]?.criteria;
            if (!criteria) return null;
            return (
              <HStack key={criteriaId} flexWrap="wrap" gap={1}>
                <Text fontWeight="bold" color="fg.muted" minW="fit-content">
                  {criteria.name}:
                </Text>
                {actions.length === 1 ? (
                  <Button size="xs" variant="surface" onClick={() => handleQuickPickSelect(actions[0])}>
                    {actions[0].label}
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="surface"
                    onClick={() =>
                      setQuickPickState({
                        isOpen: true,
                        title: `Select check for ${criteria.name}`,
                        items: actions
                      })
                    }
                  >
                    Choose check…
                  </Button>
                )}
              </HStack>
            );
          })}
        </VStack>
      </Box>

      <RubricQuickPick
        isOpen={quickPickState.isOpen}
        title={quickPickState.title}
        items={quickPickState.items}
        onSelect={handleQuickPickSelect}
        onClose={() => setQuickPickState((s) => ({ ...s, isOpen: false }))}
      />

      {applyQuickPickState.action && (
        <RubricQuickPick
          isOpen={applyQuickPickState.isOpen}
          title={`Apply ${applyQuickPickState.action.check?.name || "check"}?`}
          items={[
            {
              id: "apply",
              label: "Apply",
              check: applyQuickPickState.action.check,
              criteria: applyQuickPickState.action.criteria
            },
            {
              id: "apply-with-comment",
              label: "Apply with comment…",
              check: applyQuickPickState.action.check,
              criteria: applyQuickPickState.action.criteria
            }
          ]}
          onSelect={(a) => {
            const option = a.id === "apply" ? "apply" : "apply-with-comment";
            handleApplyQuickPickSelect(option);
          }}
          onClose={() => setApplyQuickPickState({ isOpen: false, action: null })}
        />
      )}
    </>
  );
}
