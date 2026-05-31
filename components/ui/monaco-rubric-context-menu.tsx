"use client";
import { RubricContextMenuAction, useRubricAnnotationActions } from "@/hooks/useRubricAnnotationActions";
import { SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { useEffect, useRef, useState } from "react";
import type { Monaco } from "@monaco-editor/react";
import type { IDisposable, editor } from "monaco-editor";
import { RubricQuickPick } from "./rubric-quick-pick";

// Re-export so existing importers (code-file-monaco, code-file-plain, rubric-quick-pick,
// plain-rubric-line-menu) keep importing the type from here.
export type { RubricContextMenuAction };

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
  const { menuActions } = useRubricAnnotationActions(file);

  const disposablesRef = useRef<IDisposable[]>([]);
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
            {
              id: "apply",
              label: "Apply",
              check: applyQuickPickState.action.check,
              criteria: applyQuickPickState.action.criteria
            },
            {
              id: "apply-with-comment",
              label: "Apply with comment...",
              check: applyQuickPickState.action.check,
              criteria: applyQuickPickState.action.criteria
            }
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
