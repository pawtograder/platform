"use client";
import { useRubricChecksByRubric, useRubricCriteriaByRubric, useRubricWithParts } from "@/hooks/useAssignment";
import { useSubmissionFileComments } from "@/hooks/useSubmission";
import { useActiveSubmissionReview } from "@/hooks/useSubmissionReview";
import { RubricCheck, RubricCriteria, SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { useEffect, useRef, useMemo, useState } from "react";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { isRubricCheckDataWithOptions, RubricCheckSubOption } from "./code-file";
import { RubricQuickPick } from "./rubric-quick-pick";

export type RubricContextMenuAction = {
  id: string;
  label: string;
  criteria?: RubricCriteria;
  check?: RubricCheck;
  subOption?: RubricCheckSubOption;
  isCommentAction?: boolean;
};

export type MonacoRubricContextMenuProps = {
  editor: editor.IStandaloneCodeEditor | null;
  monaco: Monaco | null;
  file: SubmissionFile | null;
  onSelectCheck: (action: RubricContextMenuAction, startLine: number, endLine: number) => void;
  onImmediateApply?: (action: RubricContextMenuAction, startLine: number, endLine: number) => void;
  onAddComment: (startLine: number, endLine: number) => void;
};

export function MonacoRubricContextMenu({
  editor,
  monaco,
  file,
  onSelectCheck,
  onImmediateApply,
  onAddComment
}: MonacoRubricContextMenuProps) {
  const review = useActiveSubmissionReview();
  const rubric = useRubricWithParts(review?.rubric_id);
  const rubricCriteria = useRubricCriteriaByRubric(rubric?.id);
  const rubricChecks = useRubricChecksByRubric(rubric?.id);
  const existingComments = useSubmissionFileComments({ file_id: file?.id ?? 0 });
  
  const disposablesRef = useRef<editor.IDisposable[]>([]);
  const lastMousePositionRef = useRef<{ top: number; left: number } | null>(null);
  const [quickPickState, setQuickPickState] = useState<{
    isOpen: boolean;
    title: string;
    items: RubricContextMenuAction[];
    position?: { top: number; left: number };
  }>({
    isOpen: false,
    title: "",
    items: []
  });
  const [applyQuickPickState, setApplyQuickPickState] = useState<{
    isOpen: boolean;
    action: RubricContextMenuAction | null;
    startLine: number;
    endLine: number;
    position?: { top: number; left: number };
  }>({
    isOpen: false,
    action: null,
    startLine: 1,
    endLine: 1
  });

  // Build menu structure
  const menuActions = useMemo(() => {
    if (!rubricCriteria || !rubricChecks || !file) {
      return [];
    }

    const actions: RubricContextMenuAction[] = [];

    // Filter annotation checks
    const annotationChecks = rubricChecks.filter(
      (check: RubricCheck) =>
        check.is_annotation && (check.annotation_target === "file" || check.annotation_target === null)
    );

    const criteriaWithChecks = rubricCriteria
      .filter((criteria: RubricCriteria) =>
        annotationChecks.some((check: RubricCheck) => check.rubric_criteria_id === criteria.id)
      )
      .sort((a, b) => a.ordinal - b.ordinal);

    // Group checks by criteria
    criteriaWithChecks.forEach((criteria: RubricCriteria) => {
      const checksForCriteria = annotationChecks
        .filter((check: RubricCheck) => check.rubric_criteria_id === criteria.id)
        .sort((a, b) => a.ordinal - b.ordinal);

      checksForCriteria.forEach((check: RubricCheck) => {
        const existingAnnotationsForCheck = existingComments.filter(
          (comment) => comment.rubric_check_id === check.id
        ).length;
        const isDisabled = check.max_annotations ? existingAnnotationsForCheck >= check.max_annotations : false;

        if (isRubricCheckDataWithOptions(check.data)) {
          // Create action for each sub-option
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
          // Single check action
          const pointsText = check.points
            ? ` (${criteria.is_additive ? "+" : "-"}${check.points} pts)`
            : "";
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

  useEffect(() => {
    if (!editor || !monaco || !file || menuActions.length === 0) {
      // Clean up existing disposables
      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];
      return;
    }

    // Clean up previous actions
    disposablesRef.current.forEach((disposable) => disposable.dispose());
    disposablesRef.current = [];

    // Helper to get selection lines
    const getSelectionLines = (): { startLine: number; endLine: number } => {
      const selection = editor.getSelection();
      if (selection) {
        return {
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber
        };
      }
      // Fallback to cursor position
      const position = editor.getPosition();
      if (position) {
        return {
          startLine: position.lineNumber,
          endLine: position.lineNumber
        };
      }
      return { startLine: 1, endLine: 1 };
    };

    // Add "Add Comment" action
    const addCommentAction = editor.addAction({
      id: "rubric-add-comment",
      label: "Add Comment...",
      contextMenuGroupId: "rubric",
      contextMenuOrder: 0,
      run: () => {
        const { startLine, endLine } = getSelectionLines();
        // Capture current mouse position when action is triggered
        if (lastMousePositionRef.current) {
          // Position already captured from mousemove/contextmenu
        }
        onAddComment(startLine, endLine);
      }
    });
    disposablesRef.current.push(addCommentAction);
    
    // Also listen to Monaco's context menu event to capture position
    const contextMenuDisposable = editor.onContextMenu((e) => {
      const browserEvent = e.event.browserEvent;
      if (browserEvent) {
        const pos = {
          top: browserEvent.clientY,
          left: browserEvent.clientX
        };
        lastMousePositionRef.current = pos;
        if (process.env.NODE_ENV === "development") {
          console.log("Context menu opened at:", pos);
        }
      }
    });
    disposablesRef.current.push(contextMenuDisposable);

    // Add separator
    const separatorAction = editor.addAction({
      id: "rubric-separator",
      label: "─────────────────",
      contextMenuGroupId: "rubric",
      contextMenuOrder: 0.5,
      run: () => {
        // Separator - no action
      }
    });
    disposablesRef.current.push(separatorAction);

    // Group actions by criteria
    const actionsByCriteria = new Map<number, RubricContextMenuAction[]>();
    menuActions.forEach((action) => {
      if (action.criteria) {
        const criteriaId = action.criteria.id;
        if (!actionsByCriteria.has(criteriaId)) {
          actionsByCriteria.set(criteriaId, []);
        }
        actionsByCriteria.get(criteriaId)!.push(action);
      }
    });

    // Create submenu actions for each criteria
    let order = 1;
    actionsByCriteria.forEach((actions, criteriaId) => {
      const criteria = actions[0].criteria!;
      
      // Create a submenu action that shows a quick pick
      const criteriaAction = editor.addAction({
        id: `rubric-criteria-${criteriaId}`,
        label: `${criteria.name} ▸`,
        contextMenuGroupId: "rubric",
        contextMenuOrder: order++,
        run: () => {
          const { startLine, endLine } = getSelectionLines();
          
          // If only one action, apply it directly
          if (actions.length === 1) {
            onSelectCheck(actions[0], startLine, endLine);
            return;
          }
          
          // Try to get current mouse position first (most accurate)
          // Fall back to last known position if not available
          let position = lastMousePositionRef.current || undefined;
          
          // Debug: log position to help troubleshoot
          if (process.env.NODE_ENV === "development") {
            console.log("Quick pick position:", position, "Last mouse pos:", lastMousePositionRef.current);
          }
          
          // If we have a position, use it; otherwise center on screen
          if (!position) {
            // Fallback: center on viewport
            position = {
              top: window.innerHeight / 2,
              left: window.innerWidth / 2
            };
          }
          
          // Show custom quick pick
          setQuickPickState({
            isOpen: true,
            title: `Select check for ${criteria.name}`,
            items: actions,
            position
          });
        }
      });
      disposablesRef.current.push(criteriaAction);
    });

    // Cleanup function
    return () => {
      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];
    };
  }, [editor, monaco, file, menuActions, onSelectCheck, onImmediateApply, onAddComment]);

  // Track mouse position globally to capture context menu location
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      lastMousePositionRef.current = {
        top: e.clientY,
        left: e.clientX
      };
    };
    
    const handleContextMenu = (e: MouseEvent) => {
      // Capture position when context menu is triggered
      lastMousePositionRef.current = {
        top: e.clientY,
        left: e.clientX
      };
    };
    
    // Track mouse movement to always have a recent position
    document.addEventListener("mousemove", handleMouseMove, { passive: true });
    // Also capture on context menu (in case mouse hasn't moved)
    document.addEventListener("contextmenu", handleContextMenu, { passive: true });
    
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  const handleQuickPickSelect = (action: RubricContextMenuAction) => {
    if (!editor) return;
    const selection = editor.getSelection();
    const startLine = selection?.startLineNumber ?? editor.getPosition()?.lineNumber ?? 1;
    const endLine = selection?.endLineNumber ?? editor.getPosition()?.lineNumber ?? 1;
    
    // If comment is required, go directly to comment dialog
    if (action.check?.is_comment_required) {
      onSelectCheck(action, startLine, endLine);
      return;
    }
    
    // If comment is not required, show "Apply" or "Apply with comment..." menu
    const position = lastMousePositionRef.current || undefined;
    setApplyQuickPickState({
      isOpen: true,
      action,
      startLine,
      endLine,
      position
    });
  };
  
  const handleApplyQuickPickSelect = (option: "apply" | "apply-with-comment") => {
    if (!applyQuickPickState.action) return;
    
    const { action, startLine, endLine } = applyQuickPickState;
    
    if (option === "apply") {
      // Immediately apply without showing comment dialog
      if (onImmediateApply) {
        onImmediateApply(action, startLine, endLine);
      }
    } else {
      // Show comment dialog
      onSelectCheck(action, startLine, endLine);
    }
    
    setApplyQuickPickState({ ...applyQuickPickState, isOpen: false });
  };

  return (
    <>
      <RubricQuickPick
        isOpen={quickPickState.isOpen}
        title={quickPickState.title}
        items={quickPickState.items}
        onSelect={handleQuickPickSelect}
        onClose={() => setQuickPickState({ ...quickPickState, isOpen: false })}
        position={quickPickState.position}
      />
      {/* Second-level quick pick for Apply/Apply with comment */}
      {applyQuickPickState.action && (
        <RubricQuickPick
          isOpen={applyQuickPickState.isOpen}
          title={`Apply ${applyQuickPickState.action.check?.name || "check"}?`}
          items={[
            { id: "apply", label: "Apply", check: applyQuickPickState.action.check, criteria: applyQuickPickState.action.criteria },
            { id: "apply-with-comment", label: "Apply with comment...", check: applyQuickPickState.action.check, criteria: applyQuickPickState.action.criteria }
          ]}
          onSelect={(action) => {
            const option = action.id === "apply" ? "apply" : "apply-with-comment";
            handleApplyQuickPickSelect(option);
          }}
          onClose={() => setApplyQuickPickState({ ...applyQuickPickState, isOpen: false })}
          position={applyQuickPickState.position}
        />
      )}
    </>
  );
}
