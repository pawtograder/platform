"use client";
import { useGraderPseudonymousMode } from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useSubmission, useSubmissionController, useSubmissionFileComments } from "@/hooks/useSubmission";
import { useDefaultWritableSubmissionReview } from "@/hooks/useSubmissionReview";
import { RubricCheck, RubricCriteria, SubmissionFile, SubmissionFileComment } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Button, Flex, HStack, Icon, Text } from "@chakra-ui/react";
import { useColorMode } from "@/components/ui/color-mode";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";
import { FaComments, FaEyeSlash, FaTimes } from "react-icons/fa";
import { Skeleton } from "./skeleton";
import { toaster } from "./toaster";
import { createPortal } from "react-dom";
import type { Monaco } from "@monaco-editor/react";
import type * as MonacoEditor from "monaco-editor";
import type { editor } from "monaco-editor";
import { MonacoRubricContextMenu, RubricContextMenuAction } from "./monaco-rubric-context-menu";
import { useRubricAnnotationActions } from "@/hooks/useRubricAnnotationActions";
import { RubricQuickApplyPalette } from "./rubric-quick-apply-palette";
import { AnnotationCommentDialog } from "./annotation-comment-dialog";
import {
  buildSymbolIndex,
  resolveDefinition,
  getSymbolLanguage,
  type SymbolIndex,
  type CodeSymbol,
  type CodeSymbolKind,
  type SymbolLanguage
} from "@/supabase/functions/_shared/CodeSymbolParser";
import { useSubmissionFileSymbols } from "@/hooks/useSubmissionFileSymbols";
import * as Sentry from "@sentry/nextjs";
import {
  isRubricCheckDataWithOptions,
  RubricCheckSubOption,
  CodeLineCommentContext,
  CodeLineCommentsPortal,
  type RubricCheckDataWithOptions,
  type CodeFileHandle,
  type CodeFileProps
} from "./code-file-shared";

const Editor = dynamic(() => import("@monaco-editor/react").then((mod) => mod.default), {
  ssr: false,
  loading: () => <Skeleton />
});

export type { RubricCheckSubOption, RubricCheckDataWithOptions, CodeFileHandle, CodeFileProps };
export { isRubricCheckDataWithOptions };

// Map file extensions to Monaco language IDs
function getMonacoLanguage(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() || "";

  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    // Web
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    xml: "xml",
    svg: "xml",
    vue: "vue",
    svelte: "svelte",
    // Programming languages
    py: "python",
    java: "java",
    cpp: "cpp",
    cxx: "cpp",
    cc: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    rb: "ruby",
    go: "go",
    rs: "rust",
    kt: "kotlin",
    swift: "swift",
    scala: "scala",
    clj: "clojure",
    hs: "haskell",
    ml: "ocaml",
    fs: "fsharp",
    elm: "elm",
    dart: "dart",
    lua: "lua",
    perl: "perl",
    pl: "perl",
    r: "r",
    m: "objective-c",
    vb: "vb",
    pas: "pascal",
    ada: "ada",
    asm: "asm",
    s: "asm",
    // Shell
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    fish: "shell",
    bat: "bat",
    ps1: "powershell",
    // Data
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    ini: "ini",
    cfg: "ini",
    conf: "ini",
    properties: "properties",
    env: "shell",
    // Documentation
    md: "markdown",
    rst: "restructuredtext",
    tex: "latex",
    // Database
    sql: "sql",
    cql: "sql",
    // Config
    dockerfile: "dockerfile",
    makefile: "makefile",
    cmake: "cmake",
    gradle: "groovy",
    // Other
    diff: "diff",
    patch: "diff",
    log: "plaintext",
    txt: "plaintext"
  };

  return languageMap[extension] || "plaintext";
}
type OpenCodeEditorInput = {
  resource: { toString(): string };
  options?: { selection?: { startLineNumber?: number; startColumn?: number } };
};
type OpenCodeEditorFn = (input: OpenCodeEditorInput, source: unknown) => Promise<unknown>;

const CodeFileMonaco = forwardRef<CodeFileHandle, CodeFileProps>(
  (
    { file: singleFile, files, activeFileId, onFileSelect, openFileIds, onFileClose, indexFiles, onNavigateToFile },
    ref
  ) => {
    const submission = useSubmission();
    // Apply rubric checks to the same review whose checks the menu offers (the default writable
    // review), so a saved annotation's submission_review_id always matches its rubric_check's rubric.
    const submissionReview = useDefaultWritableSubmissionReview();
    const showCommentsFeature = true;
    const { colorMode } = useColorMode();

    // Support both single file (legacy) and multi-file (new) modes
    const allFiles = useMemo(() => files || (singleFile ? [singleFile] : []), [files, singleFile]);

    // Files the language layer should know about: the full submission file set (for cross-file
    // go-to-definition), falling back to whatever is displayed. Drives model creation + the symbol
    // index, independent of which files are shown as tabs.
    const languageFiles = useMemo(() => indexFiles ?? allFiles, [indexFiles, allFiles]);

    // Determine which files are "open" (in tabs)
    const openFiles = useMemo(() => {
      if (openFileIds && openFileIds.length > 0) {
        return allFiles.filter((f) => openFileIds.includes(f.id));
      }
      // Default: show all files if no openFileIds specified
      return allFiles;
    }, [allFiles, openFileIds]);

    const currentFileId = activeFileId ?? singleFile?.id ?? allFiles[0]?.id;
    const currentFile = useMemo(
      () => openFiles.find((f) => f.id === currentFileId) || openFiles[0],
      [openFiles, currentFileId]
    );

    const submissionController = useSubmissionController();
    const review = submissionReview;
    const { private_profile_id, public_profile_id } = useClassProfiles();
    const isGraderOrInstructor = useIsGraderOrInstructor();
    const graderPseudonymousMode = useGraderPseudonymousMode();
    const authorProfileId = isGraderOrInstructor && graderPseudonymousMode ? public_profile_id : private_profile_id;

    // Keyboard quick-apply palette (productivity layer). Opened with Cmd/Ctrl+. while the editor is
    // focused; lists the same rubric actions as the right-click menu for the cursor's line.
    const { menuActions: quickApplyActions } = useRubricAnnotationActions(currentFile ?? null);
    const [quickApply, setQuickApply] = useState<{ isOpen: boolean; line: number }>({ isOpen: false, line: 1 });

    // State for comment dialog
    const [commentDialogState, setCommentDialogState] = useState<{
      isOpen: boolean;
      startLine: number;
      endLine: number;
      rubricCheck?: RubricCheck;
      criteria?: RubricCriteria;
      subOptionComment?: string;
      subOptionPoints?: number;
      savedScrollPosition?: { topVisibleLine?: number; scrollTop?: number; scrollLeft: number } | null;
    }>({
      isOpen: false,
      startLine: 1,
      endLine: 1
    });

    // State for pending scroll restoration
    const [pendingScrollRestore, setPendingScrollRestore] = useState<{
      topVisibleLine?: number;
      scrollTop?: number;
      scrollLeft: number;
    } | null>(null);

    // Save scroll position helper - saves the top visible line instead of absolute scroll
    const saveScrollPosition = useCallback(() => {
      const editor = editorRef.current;
      if (editor) {
        const visibleRanges = editor.getVisibleRanges();
        if (visibleRanges && visibleRanges.length > 0) {
          // Save the top visible line number - this is more stable when content changes
          return {
            topVisibleLine: visibleRanges[0].startLineNumber,
            scrollLeft: editor.getScrollLeft()
          };
        }
        // Fallback to scroll position if we can't get visible ranges
        return {
          scrollTop: editor.getScrollTop(),
          scrollLeft: editor.getScrollLeft()
        };
      }
      return null;
    }, []);

    // Restore scroll position helper - restores to show the same top line
    const restoreScrollPosition = useCallback(
      (position: { topVisibleLine?: number; scrollTop?: number; scrollLeft: number } | null) => {
        if (!position) return;
        const editor = editorRef.current;
        if (editor) {
          if (position.topVisibleLine) {
            // Restore by revealing the same line at the top - this is more stable
            editor.revealLineNearTop(position.topVisibleLine);
          } else if (position.scrollTop !== undefined) {
            // Fallback to absolute scroll position
            editor.setScrollTop(position.scrollTop);
          }
          editor.setScrollLeft(position.scrollLeft);
        }
      },
      []
    );

    // Handle context menu check selection
    const handleSelectCheck = useCallback(
      async (action: RubricContextMenuAction, startLine: number, endLine: number) => {
        if (!action.check || !currentFile || !submission) return;

        const check = action.check;
        const criteria = action.criteria;
        const subOption = action.subOption;

        // Save scroll position before opening dialog
        const savedScrollPosition = saveScrollPosition();
        if (savedScrollPosition) {
          setPendingScrollRestore(savedScrollPosition);
        }

        // If comment is required, show dialog immediately
        if (check.is_comment_required) {
          setCommentDialogState({
            isOpen: true,
            startLine,
            endLine,
            rubricCheck: check,
            criteria,
            subOptionComment: subOption?.label,
            subOptionPoints: subOption?.points
          });
          return;
        }

        // If comment is not required, show dialog (this should only be called from "Apply with comment...")
        setCommentDialogState({
          isOpen: true,
          startLine,
          endLine,
          rubricCheck: check,
          criteria,
          subOptionComment: subOption?.label,
          subOptionPoints: subOption?.points
        });
      },
      [currentFile, submission, saveScrollPosition]
    );

    // Handle immediate apply (without comment)
    const handleImmediateApply = useCallback(
      async (
        check: RubricCheck,
        criteria: RubricCriteria | undefined,
        startLine: number,
        endLine: number,
        subOption?: RubricCheckSubOption
      ) => {
        if (!currentFile || !submission || !submissionReview?.id) {
          toaster.error({
            title: "Error saving annotation",
            description: "Submission review ID is missing, cannot save rubric annotation."
          });
          return;
        }

        // Save scroll position before creating comment
        const savedPosition = saveScrollPosition();

        const points = subOption?.points ?? check.points ?? null;
        let comment = "";
        if (subOption) {
          comment = subOption.label;
        }

        const values = {
          comment,
          line: startLine,
          rubric_check_id: check.id,
          class_id: currentFile.class_id!,
          submission_file_id: currentFile.id,
          submission_id: submission.id,
          author: authorProfileId!,
          released: review?.released ?? true,
          points,
          submission_review_id: submissionReview.id,
          eventually_visible: check.student_visibility !== "never",
          regrade_request_id: null
        };

        try {
          await submissionController.submission_file_comments.create(
            values as Omit<
              SubmissionFileComment,
              "id" | "created_at" | "updated_at" | "deleted_at" | "edited_at" | "edited_by"
            >
          );

          // Set pending scroll restoration - will be restored when view zones update
          if (savedPosition) {
            setPendingScrollRestore(savedPosition);
          }

          toaster.success({ title: "Annotation added" });
        } catch (err) {
          toaster.error({
            title: "Error saving annotation",
            description: err instanceof Error ? err.message : "Unknown error"
          });
        }
      },
      [currentFile, submission, submissionReview, authorProfileId, review, submissionController, saveScrollPosition]
    );

    // Handle immediate apply (without comment dialog) - wrapper for context menu
    const handleImmediateApplyFromMenu = useCallback(
      async (action: RubricContextMenuAction, startLine: number, endLine: number) => {
        if (!action.check) return;
        await handleImmediateApply(action.check, action.criteria, startLine, endLine, action.subOption);
      },
      [handleImmediateApply]
    );

    // Handle add comment action
    const handleAddComment = useCallback(
      (startLine: number, endLine: number) => {
        // Save scroll position before opening dialog
        const savedScrollPosition = saveScrollPosition();
        if (savedScrollPosition) {
          setPendingScrollRestore(savedScrollPosition);
        }
        setCommentDialogState({
          isOpen: true,
          startLine,
          endLine
        });
      },
      [saveScrollPosition]
    );

    // Monaco's text-model registry is global (keyed by URI), but each editor pane creates a model per
    // file. In split view two panes mount at once, so they must not request the same URI — otherwise
    // the second pane throws "Cannot add model because it already exists!". Scope every model URI to
    // this instance via a unique authority; `uri.path` is unchanged, so filename lookups still work.
    const instanceId = useId().replace(/[^a-zA-Z0-9]/g, "");

    const [expanded, setExpanded] = useState<number[]>([]);
    // Flips true once the (dynamically imported) Monaco editor has mounted. Effects that draw view
    // zones key off this so they re-run after mount — otherwise comments that load before the editor
    // is ready set `expanded` while `editorRef` is still null, and their overlays never get drawn
    // until something else changes `expanded` (e.g. toggling hide/show).
    const [editorReady, setEditorReady] = useState(false);
    const [viewZoneNodes, setViewZoneNodes] = useState<Map<number, HTMLElement>>(new Map());
    const viewZoneNodesRef = useRef<Map<number, HTMLElement>>(new Map());
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const monacoRef = useRef<Monaco | null>(null);
    const modelsRef = useRef<Map<number, editor.ITextModel>>(new Map());
    const decorationsRef = useRef<Map<number, string[]>>(new Map());
    const viewZonesRef = useRef<Map<number, string>>(new Map());
    const viewZoneHeightsRef = useRef<Map<number, number>>(new Map());
    const highlightDecorationRef = useRef<string | null>(null);
    const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const symbolIndexRef = useRef<SymbolIndex>({ byName: new Map() });
    const symbolsByFileIdRef = useRef<Map<number, CodeSymbol[]>>(new Map());
    const indexedFileIdsRef = useRef<Set<number>>(new Set());
    const filesByIdRef = useRef<Map<number, SubmissionFile>>(new Map());
    const currentFileIdRef = useRef<number | undefined>(undefined);
    const symbolsLoadingRef = useRef<boolean>(true);
    // Cross-file go-to-definition switches the displayed file asynchronously; remember where to land.
    const pendingRevealRef = useRef<{ fileId: number; line: number; column: number } | null>(null);
    // Track the monkey-patched code-editor opener so we can restore it on unmount (the service can be
    // shared across editor instances; leaving stale overrides would accumulate and leak closures).
    const editorServiceRef = useRef<{ openCodeEditor: OpenCodeEditorFn } | null>(null);
    const baseOpenCodeEditorRef = useRef<OpenCodeEditorFn | null>(null);
    const overrideOpenCodeEditorRef = useRef<OpenCodeEditorFn | null>(null);
    // File ids already shown the "not yet indexed" notice (per-file, so each un-indexed file notifies
    // at most once instead of a single session-wide latch that a false fire could consume).
    const notIndexedNotifiedRef = useRef<Set<number>>(new Set());
    const providerDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);

    // Sync viewZoneNodes state to ref for use in callbacks
    useEffect(() => {
      viewZoneNodesRef.current = viewZoneNodes;
    }, [viewZoneNodes]);

    // Server-side code-symbol index for this submission (powers go-to-definition). Parsing happens
    // at ingestion, not here — we only read the stored symbols and assemble the cross-file index.
    const { symbolsByFileId, indexedFileIds, isLoading: symbolsLoading } = useSubmissionFileSymbols(submission?.id);
    const symbolIndex = useMemo(() => {
      const filesById = new Map(languageFiles.map((f) => [f.id, f]));
      const fileSymbols = [...symbolsByFileId.entries()].map(([fileId, symbols]) => ({
        fileId,
        fileName: filesById.get(fileId)?.name ?? "",
        symbols
      }));
      return buildSymbolIndex(fileSymbols);
    }, [symbolsByFileId, languageFiles]);

    // Monaco language providers are registered once at mount and read these refs at invocation time,
    // so keep them current as the index loads / the active file changes.
    useEffect(() => {
      symbolIndexRef.current = symbolIndex;
    }, [symbolIndex]);
    useEffect(() => {
      symbolsByFileIdRef.current = symbolsByFileId;
    }, [symbolsByFileId]);
    useEffect(() => {
      indexedFileIdsRef.current = indexedFileIds;
    }, [indexedFileIds]);
    useEffect(() => {
      symbolsLoadingRef.current = symbolsLoading;
    }, [symbolsLoading]);
    useEffect(() => {
      filesByIdRef.current = new Map(languageFiles.map((f) => [f.id, f]));
    }, [languageFiles]);
    useEffect(() => {
      currentFileIdRef.current = currentFile?.id;
    }, [currentFile]);

    // The editor instance persists across tab switches (stable key), but `expanded` holds bare line
    // numbers — so without resetting it on file change, expanding line N in one file would expand
    // line N in the next. Clear it when the active file changes; the new file's comments re-expand via
    // onCommentsEnter.
    useEffect(() => {
      setExpanded([]);
    }, [currentFile?.id]);

    // Track pending height updates to batch them
    const pendingHeightUpdatesRef = useRef<Map<number, number>>(new Map());
    const heightUpdateRafRef = useRef<number | null>(null);
    const isScrollingRef = useRef(false);

    // Function to update a ViewZone height (debounced and batched)
    const updateViewZoneHeight = useCallback((lineNumber: number, height: number) => {
      if (!editorRef.current || isScrollingRef.current) {
        // Queue update for after scroll
        pendingHeightUpdatesRef.current.set(lineNumber, height);
        return;
      }

      const zoneId = viewZonesRef.current.get(lineNumber);
      if (!zoneId) return;

      const currentHeight = viewZoneHeightsRef.current.get(lineNumber) || 0;
      // Only update if height changed significantly (avoid unnecessary updates)
      if (Math.abs(height - currentHeight) > 10) {
        const domNode = viewZoneNodesRef.current.get(lineNumber);
        if (!domNode) return;

        // Cancel any pending RAF
        if (heightUpdateRafRef.current !== null) {
          cancelAnimationFrame(heightUpdateRafRef.current);
        }

        // Batch updates using requestAnimationFrame
        heightUpdateRafRef.current = requestAnimationFrame(() => {
          if (!editorRef.current) return;

          // The line may have been collapsed (its zone removed by updateViewZones) between scheduling
          // and running this RAF — the comment portal's ResizeObserver keeps these updates in flight.
          // Re-adding the zone now would resurrect an empty band that holds space for a collapsed
          // comment, so bail unless this exact zone is still the tracked one for the line.
          if (viewZonesRef.current.get(lineNumber) !== zoneId) {
            heightUpdateRafRef.current = null;
            return;
          }

          editorRef.current.changeViewZones((accessor) => {
            try {
              // Remove old zone and add new one with updated height
              accessor.removeZone(zoneId);
              const newZoneId = accessor.addZone({
                afterLineNumber: lineNumber,
                heightInPx: height,
                domNode
              });
              viewZonesRef.current.set(lineNumber, newZoneId);
              viewZoneHeightsRef.current.set(lineNumber, height);
            } catch {
              // Zone may have been removed
            }
          });

          heightUpdateRafRef.current = null;
        });
      }
    }, []);

    // Handle scroll events to pause updates during scrolling
    useEffect(() => {
      if (!editorRef.current) return;

      let scrollTimeout: NodeJS.Timeout;
      const handleScroll = () => {
        isScrollingRef.current = true;
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          isScrollingRef.current = false;
          // Process any pending updates after scroll ends
          if (pendingHeightUpdatesRef.current.size > 0 && editorRef.current) {
            pendingHeightUpdatesRef.current.forEach((height, lineNumber) => {
              updateViewZoneHeight(lineNumber, height);
            });
            pendingHeightUpdatesRef.current.clear();
          }
        }, 150);
      };

      const editorDom = editorRef.current.getContainerDomNode();
      editorDom.addEventListener("scroll", handleScroll, { passive: true });

      return () => {
        editorDom.removeEventListener("scroll", handleScroll);
        clearTimeout(scrollTimeout);
        if (heightUpdateRafRef.current !== null) {
          cancelAnimationFrame(heightUpdateRafRef.current);
        }
      };
    }, [updateViewZoneHeight]);

    // Expose scrollToLine via imperative handle
    useImperativeHandle(ref, () => ({
      scrollToLine: (lineNumber: number) => {
        if (editorRef.current && lineNumber > 0) {
          editorRef.current.revealLineInCenter(lineNumber);

          // Add highlight decoration
          if (monacoRef.current && editorRef.current) {
            const model = editorRef.current.getModel();
            if (model) {
              const decorations = [
                {
                  range: new monacoRef.current.Range(lineNumber, 1, lineNumber, 1),
                  options: {
                    isWholeLine: true,
                    className: "monaco-line-highlight",
                    glyphMarginClassName: "monaco-line-highlight-glyph"
                  }
                }
              ];

              // Remove previous highlight
              if (highlightDecorationRef.current) {
                editorRef.current.deltaDecorations([highlightDecorationRef.current], []);
              }

              const decorationIds = editorRef.current.deltaDecorations([], decorations);
              highlightDecorationRef.current = decorationIds[0];

              // Fade out after 2 seconds. Track the timer so a rapid re-trigger or unmount can cancel
              // it — otherwise it can fire on a disposed editor (editorRef is not nulled on unmount).
              if (highlightTimeoutRef.current) {
                clearTimeout(highlightTimeoutRef.current);
              }
              highlightTimeoutRef.current = setTimeout(() => {
                highlightTimeoutRef.current = null;
                if (editorRef.current && highlightDecorationRef.current) {
                  editorRef.current.deltaDecorations([highlightDecorationRef.current], []);
                  highlightDecorationRef.current = null;
                }
              }, 2000);
            }
          }
          return true;
        }
        // Editor not mounted yet (or invalid line) — report failure so callers can retry.
        return false;
      }
    }));

    const onCommentsEnter = useCallback(
      (newlyEnteredComments: SubmissionFileComment[]) => {
        if (showCommentsFeature && currentFile) {
          setExpanded((currentExpanded) => {
            const linesFromNewComments = newlyEnteredComments.map((comment) => comment.line);
            const linesToAdd = linesFromNewComments.filter((line) => !currentExpanded.includes(line));
            if (linesToAdd.length > 0) {
              return [...currentExpanded, ...linesToAdd];
            }
            return currentExpanded;
          });
        }
      },
      [showCommentsFeature, currentFile]
    );

    const _comments = useSubmissionFileComments({
      file_id: currentFile?.id,
      onEnter: onCommentsEnter
    });

    // Comments are filtered by expanded state in the component that uses them

    // Get all comments for current file (for glyph decorations)
    const allFileComments = useMemo(() => {
      if (!currentFile) return [];
      return _comments.filter((comment) => comment.submission_file_id === currentFile.id);
    }, [_comments, currentFile]);

    // Group comments by line
    const commentsByLine = useMemo(() => {
      const grouped = new Map<number, SubmissionFileComment[]>();
      allFileComments.forEach((comment) => {
        const existing = grouped.get(comment.line) || [];
        grouped.set(comment.line, [...existing, comment]);
      });
      return grouped;
    }, [allFileComments]);

    // Update glyph decorations when comments or expanded state changes
    const updateGlyphDecorations = useCallback(
      (
        editor: editor.IStandaloneCodeEditor,
        monaco: Monaco,
        commentsByLineMap: Map<number, SubmissionFileComment[]>
      ) => {
        if (!currentFile) return;

        const fileId = currentFile.id;
        const existingDecorations = decorationsRef.current.get(fileId) || [];

        const newDecorations: editor.IModelDeltaDecoration[] = [];
        commentsByLineMap.forEach((lineComments, lineNumber) => {
          if (lineComments.length > 0) {
            newDecorations.push({
              range: new monaco.Range(lineNumber, 1, lineNumber, 1),
              options: {
                glyphMarginClassName: "monaco-comment-glyph",
                glyphMarginHoverMessage: {
                  value: `${lineComments.length} comment${lineComments.length > 1 ? "s" : ""}`
                },
                minimap: {
                  color: "#4A90E2",
                  position: monaco.editor.MinimapPosition.Inline
                }
              }
            });
          }
        });

        const decorationIds = editor.deltaDecorations(existingDecorations, newDecorations);
        decorationsRef.current.set(fileId, decorationIds);
      },
      [currentFile]
    );

    // Update view zones for inline comments
    const updateViewZones = useCallback(
      (
        editor: editor.IStandaloneCodeEditor,
        monaco: Monaco,
        commentsByLineMap: Map<number, SubmissionFileComment[]>,
        expandedLines: number[],
        file: SubmissionFile | undefined
      ) => {
        if (!file || !editorRef.current) return;

        const fileId = file.id;

        // Drop any in-flight / queued height updates: they captured zone ids that we're about to
        // invalidate, and applying them after the rebuild would resurrect zones for collapsed lines.
        if (heightUpdateRafRef.current !== null) {
          cancelAnimationFrame(heightUpdateRafRef.current);
          heightUpdateRafRef.current = null;
        }
        pendingHeightUpdatesRef.current.clear();

        // Remove all existing view zones for this file
        const existingZoneIds = Array.from(viewZonesRef.current.entries())
          .filter(([, zoneId]) => zoneId !== undefined)
          .map(([lineNum, zoneId]) => ({ lineNum, zoneId: zoneId! }));

        editor.changeViewZones((accessor) => {
          existingZoneIds.forEach(({ zoneId }) => {
            try {
              accessor.removeZone(zoneId);
            } catch {
              // Zone may have already been removed
            }
          });
        });

        // Clear refs and state
        viewZonesRef.current.clear();
        viewZoneHeightsRef.current.clear();
        viewZoneNodesRef.current.clear();
        setViewZoneNodes(new Map());

        // Add new view zones for expanded comments
        const newViewZoneNodes = new Map<number, HTMLElement>();
        expandedLines.forEach((lineNumber) => {
          const lineComments = commentsByLineMap.get(lineNumber);
          if (lineComments && lineComments.length > 0) {
            editor.changeViewZones((accessor) => {
              const domNode = document.createElement("div");
              domNode.id = `comment-zone-${fileId}-${lineNumber}`;
              domNode.style.width = "100%";
              domNode.style.minHeight = "100px"; // Initial minimum height
              // Monaco view zones are transparent by default, so the editor's code lines bleed
              // through the rubric annotation. Paint a solid theme-aware background (and a top border
              // to separate it from the code above) so applied checks render on an opaque surface.
              domNode.style.background = "var(--chakra-colors-bg)";
              domNode.style.borderTop = "1px solid var(--chakra-colors-border-emphasized)";
              newViewZoneNodes.set(lineNumber, domNode);

              // Start with a reasonable initial height, will be updated after content renders
              const initialHeight = 300;
              const zoneId = accessor.addZone({
                afterLineNumber: lineNumber,
                heightInPx: initialHeight,
                domNode
              });
              viewZonesRef.current.set(lineNumber, zoneId);
              viewZoneHeightsRef.current.set(lineNumber, initialHeight);
            });
          }
        });
        viewZoneNodesRef.current = newViewZoneNodes;
        setViewZoneNodes(newViewZoneNodes);
      },
      []
    );

    // Handle Monaco editor mount
    const handleEditorDidMount = useCallback(
      (editor: editor.IStandaloneCodeEditor, monaco: Monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        setEditorReady(true);

        // Create models for every submission file (not just the displayed one) so cross-file
        // go-to-definition can target them. Scoped to this editor instance so split panes don't
        // collide on the global model registry.
        languageFiles.forEach((f) => {
          if (!modelsRef.current.has(f.id)) {
            const language = getMonacoLanguage(f.name);
            const uri = monaco.Uri.from({ scheme: "file", authority: `pane-${instanceId}`, path: `/${f.name}` });
            const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(f.contents ?? "", language, uri);
            modelsRef.current.set(f.id, model);
          }
        });

        // Set initial model
        if (currentFile) {
          const model = modelsRef.current.get(currentFile.id);
          if (model) {
            editor.setModel(model);
          }
        }

        // Clean up old providers
        providerDisposablesRef.current.forEach((disposable) => disposable.dispose());
        providerDisposablesRef.current = [];

        // Map a Monaco model back to its submission file id (modelsRef is keyed by file id).
        const fileIdForModel = (model: editor.ITextModel): number | undefined => {
          for (const [fileId, m] of modelsRef.current.entries()) {
            if (m === model) return fileId;
          }
          return undefined;
        };

        // Gentle, once-per-file notice when go-to-definition is attempted on a file the server hasn't
        // indexed yet (old submission pre-backfill, or an unsupported language).
        const notifyNotIndexed = (fileId: number) => {
          if (notIndexedNotifiedRef.current.has(fileId)) return;
          notIndexedNotifiedRef.current.add(fileId);
          toaster.create({
            title: "Not yet indexed",
            description: "Go to definition isn't available for this file yet — it works once indexing completes.",
            type: "info"
          });
          Sentry.captureMessage("Go-to-definition attempted on an un-indexed submission file", "info");
        };

        const SYMBOL_KIND_MAP: Record<CodeSymbolKind, MonacoEditor.languages.SymbolKind> = {
          class: monaco.languages.SymbolKind.Class,
          interface: monaco.languages.SymbolKind.Interface,
          enum: monaco.languages.SymbolKind.Enum,
          type: monaco.languages.SymbolKind.Interface,
          method: monaco.languages.SymbolKind.Method,
          constructor: monaco.languages.SymbolKind.Constructor,
          field: monaco.languages.SymbolKind.Field,
          function: monaco.languages.SymbolKind.Function,
          variable: monaco.languages.SymbolKind.Variable
        };

        const registerProvidersForLanguage = (languageId: string) => {
          const definitionProvider = monaco.languages.registerDefinitionProvider(languageId, {
            provideDefinition: (model, position) => {
              const word = model.getWordAtPosition(position);
              if (!word) return [];
              // Only answer for models owned by THIS editor instance — in split view both panes
              // register a provider for the same language, and Monaco invokes them all.
              const currentFileId = fileIdForModel(model);
              if (currentFileId === undefined) return [];
              // While the server index is still loading we can't tell indexed from un-indexed, so stay
              // silent. Once loaded, if this file has no index row, tell the user (once) rather than
              // silently doing nothing.
              if (symbolsLoadingRef.current) return [];
              if (!indexedFileIdsRef.current.has(currentFileId)) {
                notifyNotIndexed(currentFileId);
                return [];
              }
              const resolved = resolveDefinition(word.word, currentFileId, symbolIndexRef.current);
              if (!resolved) return [];
              const targetModel = modelsRef.current.get(resolved.fileId);
              if (!targetModel) return [];
              return {
                uri: targetModel.uri,
                range: {
                  startLineNumber: resolved.line,
                  startColumn: resolved.column,
                  endLineNumber: resolved.line,
                  endColumn: resolved.column + resolved.name.length
                }
              };
            }
          });
          providerDisposablesRef.current.push(definitionProvider);

          // Document symbols power "Go to Symbol" (Cmd+Shift+O).
          const documentSymbolProvider = monaco.languages.registerDocumentSymbolProvider(languageId, {
            provideDocumentSymbols: (model) => {
              if (!model || !model.uri || model.uri.scheme !== "file") return [];
              const fileId = fileIdForModel(model);
              if (fileId === undefined) return [];
              const symbols = symbolsByFileIdRef.current.get(fileId);
              if (!symbols) return [];
              return symbols
                .filter((symbol) => symbol && symbol.name && symbol.line)
                .map((symbol) => {
                  const range = {
                    startLineNumber: Math.max(1, symbol.line || 1),
                    startColumn: Math.max(1, symbol.column || 1),
                    endLineNumber: Math.max(1, symbol.line || 1),
                    endColumn: Math.max(1, (symbol.column || 1) + (symbol.name?.length || 0))
                  };
                  return {
                    name: symbol.name,
                    kind: SYMBOL_KIND_MAP[symbol.kind] ?? monaco.languages.SymbolKind.Variable,
                    detail: "",
                    tags: [],
                    range,
                    selectionRange: range
                  };
                });
            }
          });
          providerDisposablesRef.current.push(documentSymbolProvider);
        };

        // Register providers once per language present among the submission files.
        const languagesPresent = new Set<SymbolLanguage>();
        for (const f of languageFiles) {
          const lang = getSymbolLanguage(f.name);
          if (lang) languagesPresent.add(lang);
        }
        for (const lang of languagesPresent) {
          registerProvidersForLanguage(lang);
        }

        // Cross-file navigation: a definition in another file resolves to a different model than the
        // one attached to this standalone editor, which the default opener cannot switch to (it
        // returns null). Override it to switch the displayed file via onNavigateToFile and remember
        // where to land; the model-switch effect performs the reveal once the new file mounts.
        const editorService = (editor as unknown as { _codeEditorService?: { openCodeEditor: OpenCodeEditorFn } })
          ._codeEditorService;
        if (editorService && typeof editorService.openCodeEditor === "function" && onNavigateToFile) {
          const openBase = editorService.openCodeEditor.bind(editorService);
          const override: OpenCodeEditorFn = async (input, source) => {
            const result = await openBase(input, source);
            // Only handle resources that belong to THIS instance's models; otherwise defer to the
            // base (which may be another pane's override in a shared-service chain).
            if (result === null && input?.resource) {
              const target = [...modelsRef.current.entries()].find(
                ([, m]) => m.uri.toString() === input.resource.toString()
              );
              if (target && target[0] !== currentFileIdRef.current) {
                const selection = input.options?.selection;
                pendingRevealRef.current = {
                  fileId: target[0],
                  line: selection?.startLineNumber ?? 1,
                  column: selection?.startColumn ?? 1
                };
                onNavigateToFile(target[0]);
                return source ?? editor;
              }
            }
            return result;
          };
          editorService.openCodeEditor = override;
          editorServiceRef.current = editorService;
          baseOpenCodeEditorRef.current = openBase;
          overrideOpenCodeEditorRef.current = override;
        }

        // Update decorations when comments change
        updateGlyphDecorations(editor, monaco, commentsByLine);
        updateViewZones(editor, monaco, commentsByLine, expanded, currentFile);

        // Mouse down handler for glyph margin clicks (expand/collapse comments)
        editor.onMouseDown((e) => {
          // Handle glyph margin clicks for expanding/collapsing comments
          if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
            if (e.target.position) {
              const lineNumber = e.target.position.lineNumber;
              setExpanded((prev) => {
                if (prev.includes(lineNumber)) {
                  return prev.filter((l) => l !== lineNumber);
                } else {
                  return [...prev, lineNumber];
                }
              });
            }
          }
        });

        // Quick-apply rubric check on the cursor line (productivity layer). Scoped to the editor via
        // addAction so it cannot collide with the global file-tree j/k handler (which bails inside
        // .monaco-editor) and deliberately avoids Monaco's reserved chords (Cmd+F, Cmd+Shift+O, Cmd+Click).
        const quickApplyAction = editor.addAction({
          id: "rubric-quick-apply",
          label: "Apply rubric check…",
          // Cmd/Ctrl+. ("quick action", like VS Code's code-action) — deliberately NOT Cmd/Ctrl+K,
          // which the app reserves for global search. Bind BOTH the CtrlCmd and WinCtrl variants so the
          // chord fires regardless of whether the browser reports a Mac platform (Monaco maps CtrlCmd to
          // Cmd on Mac, Ctrl elsewhere) — otherwise Ctrl+. silently no-ops on Safari/WebKit.
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period, monaco.KeyMod.WinCtrl | monaco.KeyCode.Period],
          // "navigation" is Monaco's first context-menu group, and a negative order pins this to the
          // very top of the right-click menu (above "Add Comment…" and the per-criteria submenus).
          contextMenuGroupId: "navigation",
          contextMenuOrder: -100,
          run: (ed) => {
            const line = ed.getPosition()?.lineNumber ?? 1;
            setQuickApply({ isOpen: true, line });
          }
        });
        providerDisposablesRef.current.push(quickApplyAction);
      },
      [
        languageFiles,
        currentFile,
        commentsByLine,
        expanded,
        instanceId,
        onNavigateToFile,
        updateGlyphDecorations,
        updateViewZones
      ]
    );

    // Update decorations and view zones when comments or expanded state changes (and once the editor
    // becomes ready, so overlays for comments that loaded pre-mount get drawn).
    useEffect(() => {
      if (editorRef.current && monacoRef.current && currentFile) {
        updateGlyphDecorations(editorRef.current, monacoRef.current, commentsByLine);
        updateViewZones(editorRef.current, monacoRef.current, commentsByLine, expanded, currentFile);
      }
    }, [commentsByLine, expanded, currentFile, editorReady, updateGlyphDecorations, updateViewZones]);

    // Restore scroll when view zones finish updating
    useEffect(() => {
      if (pendingScrollRestore && editorRef.current) {
        // Use requestAnimationFrame to ensure DOM has updated
        requestAnimationFrame(() => {
          if (editorRef.current && pendingScrollRestore) {
            restoreScrollPosition(pendingScrollRestore);
            setPendingScrollRestore(null);
          }
        });
      }
    }, [commentsByLine, expanded, pendingScrollRestore, restoreScrollPosition]);

    // Switch model when active file changes
    useEffect(() => {
      if (editorRef.current && currentFile) {
        const model = modelsRef.current.get(currentFile.id);
        if (model) {
          editorRef.current.setModel(model);
          // Update decorations for new file
          if (monacoRef.current) {
            updateGlyphDecorations(editorRef.current, monacoRef.current, commentsByLine);
            updateViewZones(editorRef.current, monacoRef.current, commentsByLine, expanded, currentFile);
          }
          // Land on a cross-file go-to-definition target once its file has become active.
          const pending = pendingRevealRef.current;
          if (pending && pending.fileId === currentFile.id) {
            pendingRevealRef.current = null;
            const ed = editorRef.current;
            requestAnimationFrame(() => {
              ed.revealLineInCenter(pending.line);
              ed.setPosition({ lineNumber: pending.line, column: pending.column });
              ed.focus();
            });
          }
        }
      }
    }, [currentFile, commentsByLine, expanded, updateGlyphDecorations, updateViewZones]);

    // Cleanup models and providers on unmount
    useEffect(() => {
      const models = modelsRef.current;
      const decorations = decorationsRef.current;
      const viewZones = viewZonesRef.current;
      const providerDisposables = providerDisposablesRef.current;

      return () => {
        if (highlightTimeoutRef.current) {
          clearTimeout(highlightTimeoutRef.current);
          highlightTimeoutRef.current = null;
        }
        models.forEach((model) => model.dispose());
        models.clear();
        decorations.clear();
        viewZones.clear();
        setViewZoneNodes(new Map());
        providerDisposables.forEach((disposable) => disposable.dispose());
        providerDisposables.length = 0;
        // Restore the code-editor opener if our override is still the installed one (avoids leaving a
        // stale closure over this disposed instance on a service that may be shared across editors).
        const svc = editorServiceRef.current;
        if (svc && baseOpenCodeEditorRef.current && svc.openCodeEditor === overrideOpenCodeEditorRef.current) {
          svc.openCodeEditor = baseOpenCodeEditorRef.current;
        }
        editorServiceRef.current = null;
        baseOpenCodeEditorRef.current = null;
        overrideOpenCodeEditorRef.current = null;
      };
    }, []);

    // Handle editor before mount (worker setup)
    const handleEditorWillMount = useCallback(() => {
      if (typeof window !== "undefined") {
        window.MonacoEnvironment = {
          getWorker(_moduleId, label) {
            switch (label) {
              case "editorWorkerService":
                return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker", import.meta.url));
              default:
                throw new Error(`Unknown label ${label}`);
            }
          }
        };
      }
    }, []);

    const commentsForCurrentFile = useMemo(() => {
      if (!currentFile) return [];
      return allFileComments.filter((c) => expanded.includes(c.line));
    }, [allFileComments, expanded, currentFile]);

    if (!currentFile) {
      return <Skeleton />;
    }

    return (
      <Box
        border="1px solid"
        borderColor="border.emphasized"
        p={0}
        m={0}
        w="100%"
        h="100%"
        minH={0}
        display="flex"
        flexDirection="column"
        css={{
          "& .monaco-line-highlight": {
            backgroundColor: "rgba(255, 235, 59, 0.3)",
            transition: "opacity 2s ease-out"
          },
          "& .monaco-comment-glyph": {
            "&::before": {
              content: '"💬"',
              fontSize: "14px",
              cursor: "pointer"
            }
          },
          // The comment overlays live in Monaco view zones, but `.view-lines` (the code text layer)
          // is painted after `.view-zones` with the same `z-index: auto`, so it sits on top and
          // swallows clicks meant for the overlay's buttons. Lift the view-zone layer above the text
          // so its controls are clickable, but keep the container click-through (pointer-events: none)
          // so clicks on actual code lines still reach `.view-lines` for cursor placement — only the
          // zone content itself re-enables pointer events.
          "& .view-zones": {
            zIndex: 2,
            pointerEvents: "none"
          },
          "& .view-zones > *": {
            pointerEvents: "auto"
          }
        }}
      >
        {/* Tab bar for multiple files */}
        {openFiles.length > 1 && (
          <Flex
            w="100%"
            flexShrink={0}
            bg="bg.subtle"
            borderBottom="1px solid"
            borderColor="border.emphasized"
            alignItems="stretch"
            overflowX="auto"
            css={{
              "&::-webkit-scrollbar": {
                height: "6px"
              },
              "&::-webkit-scrollbar-track": {
                background: "transparent"
              },
              "&::-webkit-scrollbar-thumb": {
                background: "var(--chakra-colors-border-emphasized)",
                borderRadius: "3px"
              }
            }}
          >
            {openFiles.map((f) => {
              const fileComments = _comments.filter((c) => c.submission_file_id === f.id);
              const isActive = f.id === currentFileId;
              const fileName = f.name.split("/").pop() || f.name;
              return (
                <Flex
                  key={f.id}
                  bg={isActive ? "bg" : "bg.subtle"}
                  borderRight="1px solid"
                  borderColor="border.emphasized"
                  alignItems="center"
                  gap={1}
                  px={3}
                  py={2}
                  cursor="pointer"
                  _hover={{ bg: isActive ? "bg" : "bg.muted" }}
                  onClick={() => {
                    if (onFileSelect) {
                      onFileSelect(f.id);
                    }
                  }}
                  minW="fit-content"
                  position="relative"
                >
                  <Text fontSize="sm" fontWeight={isActive ? "semibold" : "normal"} lineClamp={1} maxW="200px">
                    {fileName}
                  </Text>
                  {fileComments.length > 0 && (
                    <Badge colorPalette="blue" size="sm">
                      {fileComments.length}
                    </Badge>
                  )}
                  {onFileClose && openFiles.length > 1 && (
                    <Icon
                      as={FaTimes}
                      boxSize={3}
                      color="fg.muted"
                      _hover={{ color: "fg.default" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onFileClose(f.id);
                      }}
                      ml={1}
                      flexShrink={0}
                    />
                  )}
                </Flex>
              );
            })}
          </Flex>
        )}

        {/* File header */}
        <Flex
          w="100%"
          flexShrink={0}
          bg="bg.subtle"
          p={2}
          borderBottom="1px solid"
          borderColor="border.emphasized"
          alignItems="center"
          justifyContent="space-between"
        >
          <Text fontSize="xs" color="text.subtle">
            {currentFile.name}
          </Text>
          <HStack>
            {showCommentsFeature && allFileComments.length > 0 && (
              <>
                <Text fontSize="xs" color="text.subtle">
                  {allFileComments.length} {allFileComments.length === 1 ? "comment" : "comments"}
                </Text>
                <Button
                  variant={commentsForCurrentFile.length > 0 ? "solid" : "outline"}
                  size="xs"
                  colorPalette="teal"
                  onClick={() => {
                    setExpanded((prev) => {
                      // Hide if any of this file's comments are currently shown; otherwise show them all.
                      const anyShown = allFileComments.some((c) => prev.includes(c.line));
                      if (anyShown) {
                        const lines = new Set(allFileComments.map((c) => c.line));
                        return prev.filter((l) => !lines.has(l));
                      }
                      return Array.from(new Set([...prev, ...allFileComments.map((c) => c.line)]));
                    });
                  }}
                >
                  <Icon as={commentsForCurrentFile.length > 0 ? FaEyeSlash : FaComments} />
                  {commentsForCurrentFile.length > 0 ? "Hide all comments" : "Show all comments"}
                </Button>
              </>
            )}
          </HStack>
        </Flex>

        {/* Monaco Editor — fills the remaining height of its container */}
        <Box flex="1" minH={0} width="100%">
          <Editor
            height="100%"
            width="100%"
            theme={colorMode === "dark" ? "vs-dark" : "vs"}
            beforeMount={handleEditorWillMount}
            onMount={handleEditorDidMount}
            options={{
              readOnly: true,
              lineNumbers: "on",
              glyphMargin: true,
              minimap: { enabled: true },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              fontSize: 14,
              tabSize: 2,
              insertSpaces: true,
              folding: true,
              lineDecorationsWidth: 10,
              lineNumbersMinChars: 3,
              quickSuggestions: false,
              links: true,
              // Enable Cmd+Click for go to definition
              gotoLocation: {
                multiple: "peek"
              }
            }}
          />
        </Box>

        {/* Monaco context menu for rubric annotations */}
        {editorRef.current && monacoRef.current && currentFile && (
          <MonacoRubricContextMenu
            editor={editorRef.current}
            monaco={monacoRef.current}
            file={currentFile}
            onSelectCheck={handleSelectCheck}
            onImmediateApply={handleImmediateApplyFromMenu}
            onAddComment={handleAddComment}
          />
        )}

        {/* Keyboard quick-apply palette (Cmd/Ctrl+K). One-click apply for checks that don't require a
            comment; otherwise routes to the comment dialog. */}
        <RubricQuickApplyPalette
          isOpen={quickApply.isOpen}
          onClose={() => setQuickApply((s) => ({ ...s, isOpen: false }))}
          actions={quickApplyActions}
          lineNumber={quickApply.line}
          onPick={(action) => {
            if (action.check?.is_comment_required) {
              handleSelectCheck(action, quickApply.line, quickApply.line);
            } else {
              void handleImmediateApplyFromMenu(action, quickApply.line, quickApply.line);
            }
          }}
        />

        {/* Comment dialog */}
        {currentFile && commentDialogState.rubricCheck && (
          <AnnotationCommentDialog
            isOpen={commentDialogState.isOpen}
            onClose={() => setCommentDialogState({ ...commentDialogState, isOpen: false })}
            onImmediateApply={() => {
              if (commentDialogState.rubricCheck && commentDialogState.criteria) {
                handleImmediateApply(
                  commentDialogState.rubricCheck,
                  commentDialogState.criteria,
                  commentDialogState.startLine,
                  commentDialogState.endLine,
                  commentDialogState.subOptionComment && commentDialogState.subOptionPoints
                    ? {
                        label: commentDialogState.subOptionComment,
                        points: commentDialogState.subOptionPoints
                      }
                    : undefined
                );
              }
            }}
            submission={submission}
            file={currentFile}
            startLine={commentDialogState.startLine}
            endLine={commentDialogState.endLine}
            rubricCheck={commentDialogState.rubricCheck}
            criteria={commentDialogState.criteria}
            subOptionComment={commentDialogState.subOptionComment}
            subOptionPoints={commentDialogState.subOptionPoints}
            submissionReviewId={review?.id}
            released={review?.released ?? true}
          />
        )}
        {/* Comment dialog for plain comments (no rubric check) */}
        {currentFile && !commentDialogState.rubricCheck && (
          <AnnotationCommentDialog
            isOpen={commentDialogState.isOpen}
            onClose={() => setCommentDialogState({ ...commentDialogState, isOpen: false })}
            submission={submission}
            file={currentFile}
            startLine={commentDialogState.startLine}
            endLine={commentDialogState.endLine}
            submissionReviewId={review?.id}
            released={review?.released ?? true}
          />
        )}

        {/* Context provider for comments */}
        <CodeLineCommentContext.Provider
          value={{
            submission,
            comments: allFileComments,
            file: currentFile,
            expanded,
            open: (line: number) => {
              setExpanded((prev) => {
                if (prev.includes(line)) {
                  return prev;
                }
                return [...prev, line];
              });
            },
            close: (line: number) => {
              setExpanded((prev) => prev.filter((l) => l !== line));
            },
            showCommentsFeature,
            submissionReviewId: submissionReview?.id
          }}
        >
          {/* Render comment view zones via portals - must be inside context provider */}
          {Array.from(viewZoneNodes.entries()).map(([lineNumber, domNode]) => {
            const lineComments = commentsByLine.get(lineNumber);
            if (!lineComments || lineComments.length === 0) return null;

            return createPortal(
              <CodeLineCommentsPortal
                key={`${currentFile.id}-${lineNumber}`}
                lineNumber={lineNumber}
                comments={lineComments}
                onHeightChange={(height) => updateViewZoneHeight(lineNumber, height)}
              />,
              domNode
            );
          })}
        </CodeLineCommentContext.Provider>
      </Box>
    );
  }
);

CodeFileMonaco.displayName = "CodeFileMonaco";

export default CodeFileMonaco;
