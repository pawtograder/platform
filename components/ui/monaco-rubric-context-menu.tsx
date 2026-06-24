"use client";
import { RubricContextMenuAction, useRubricAnnotationActions } from "@/hooks/useRubricAnnotationActions";
import { SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { useCallback, useEffect, useRef, useState } from "react";
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
  // Flyout listing one criteria's checks. Monaco's native menu can't render a non-selectable criteria
  // header above inline checks (it hides disabled items), so instead each criteria is one native menu
  // item that opens this flyout — the (possibly long) criteria name is shown once, and only checks are
  // applyable.
  const [flyout, setFlyout] = useState<{
    isOpen: boolean;
    title: string;
    items: RubricContextMenuAction[];
    position?: { top: number; left: number };
  }>({ isOpen: false, title: "", items: [] });

  // Track the pointer so the flyout opens near where the menu was invoked.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      lastMousePositionRef.current = { top: e.clientY, left: e.clientX };
    };
    document.addEventListener("mousemove", handler, { passive: true });
    document.addEventListener("contextmenu", handler, { passive: true });
    return () => {
      document.removeEventListener("mousemove", handler);
      document.removeEventListener("contextmenu", handler);
    };
  }, []);

  const getSelectionLines = useCallback((): { startLine: number; endLine: number } => {
    const selection = editor?.getSelection();
    if (selection) {
      return { startLine: selection.startLineNumber, endLine: selection.endLineNumber };
    }
    const position = editor?.getPosition();
    if (position) {
      return { startLine: position.lineNumber, endLine: position.lineNumber };
    }
    return { startLine: 1, endLine: 1 };
  }, [editor]);

  // Apply a check: comment-required checks open the comment dialog; everything else applies immediately.
  const applyCheck = useCallback(
    (action: RubricContextMenuAction) => {
      const { startLine, endLine } = getSelectionLines();
      if (action.check?.is_comment_required || !onImmediateApply) {
        onSelectCheck(action, startLine, endLine);
      } else {
        onImmediateApply(action, startLine, endLine);
      }
    },
    [getSelectionLines, onImmediateApply, onSelectCheck]
  );

  useEffect(() => {
    if (!editor || !monaco || !file || menuActions.length === 0) {
      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];
      return;
    }

    // Clean up previous actions
    disposablesRef.current.forEach((disposable) => disposable.dispose());
    disposablesRef.current = [];

    let order = 0;
    const addItem = (id: string, label: string, run: () => void) => {
      disposablesRef.current.push(
        editor.addAction({ id, label, contextMenuGroupId: "rubric", contextMenuOrder: order++, run })
      );
    };

    addItem("rubric-add-comment", "Add Comment...", () => {
      const { startLine, endLine } = getSelectionLines();
      onAddComment(startLine, endLine);
    });

    // Group checks by criteria, preserving the criteria/check ordering the hook already applied.
    const groups: { criteriaId: number; criteriaName: string; actions: RubricContextMenuAction[] }[] = [];
    const indexByCriteria = new Map<number, number>();
    menuActions.forEach((action) => {
      if (!action.criteria) return;
      const cid = action.criteria.id;
      let idx = indexByCriteria.get(cid);
      if (idx === undefined) {
        idx = groups.length;
        indexByCriteria.set(cid, idx);
        groups.push({ criteriaId: cid, criteriaName: action.criteria.name, actions: [] });
      }
      groups[idx].actions.push(action);
    });

    // One native menu item per criteria (its name shown once). Clicking always opens a flyout of that
    // criteria's checks — even for a single-check criteria — so the grader picks the check explicitly
    // rather than the criteria silently applying/opening a comment form.
    groups.forEach((group) => {
      addItem(`rubric-criteria-${group.criteriaId}`, `${group.criteriaName} ▸`, () => {
        const position = lastMousePositionRef.current ?? {
          top: window.innerHeight / 2,
          left: window.innerWidth / 2
        };
        setFlyout({ isOpen: true, title: group.criteriaName, items: group.actions, position });
      });
    });

    return () => {
      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];
    };
  }, [editor, monaco, file, menuActions, applyCheck, getSelectionLines, onAddComment]);

  return (
    <RubricQuickPick
      isOpen={flyout.isOpen}
      title={flyout.title}
      items={flyout.items}
      position={flyout.position}
      onSelect={(action) => applyCheck(action)}
      onClose={() => setFlyout((f) => ({ ...f, isOpen: false }))}
    />
  );
}
