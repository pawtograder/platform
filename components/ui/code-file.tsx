"use client";
import { Tooltip } from "@/components/ui/tooltip";
import {
  useGraderPseudonymousMode,
  useRubricCheck,
  useRubricChecksByRubric,
  useRubricCriteria,
  useRubricCriteriaByRubric,
  useRubricWithParts
} from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import {
  useSubmission,
  useSubmissionController,
  useSubmissionFileComment,
  useSubmissionFileComments
} from "@/hooks/useSubmission";
import { useActiveSubmissionReview } from "@/hooks/useSubmissionReview";
import { useUserProfile } from "@/hooks/useUserProfiles";
import {
  Json,
  RubricCheck,
  RubricCriteria,
  SubmissionFile,
  SubmissionFileComment,
  SubmissionWithGraderResultsAndFiles
} from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Button, Flex, HStack, Icon, Separator, Tag, Text, VStack } from "@chakra-ui/react";
import { useUpdate } from "@refinedev/core";
import { useColorMode } from "@/components/ui/color-mode";
import { chakraComponents, Select, SelectComponentsConfig, SelectInstance } from "chakra-react-select";
import { format } from "date-fns";
import dynamic from "next/dynamic";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef
} from "react";
import { FaCheckCircle, FaComments, FaEyeSlash, FaRegEyeSlash, FaTimesCircle, FaTimes } from "react-icons/fa";
import LineCommentForm from "./line-comments-form";
import Markdown from "./markdown";
import MessageInput from "./message-input";
import PersonAvatar from "./person-avatar";
import RegradeRequestWrapper from "./regrade-request-wrapper";
import RequestRegradeDialog from "./request-regrade-dialog";
import { CommentActions, ReviewRoundTag, StudentVisibilityIndicator } from "./rubric-sidebar";
import { Skeleton } from "./skeleton";
import { toaster } from "./toaster";
import { createPortal } from "react-dom";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { MonacoRubricContextMenu, RubricContextMenuAction } from "./monaco-rubric-context-menu";
import { AnnotationCommentDialog } from "./annotation-comment-dialog";
import {
  parseJavaFile,
  buildSymbolIndex,
  resolveType,
  findReferences,
  type SymbolIndex,
  type JavaFileSymbols,
  type JavaSymbol
} from "@/lib/java-language-service";

// Dynamic import of Monaco Editor to reduce build memory usage
const Editor = dynamic(() => import("@monaco-editor/react").then((mod) => mod.default), {
  ssr: false,
  loading: () => <Skeleton />
});

export type RubricCheckSubOption = {
  label: string;
  points: number;
};

export type RubricCheckDataWithOptions = {
  options: RubricCheckSubOption[];
};

export function isRubricCheckDataWithOptions(data: Json | null | undefined): data is RubricCheckDataWithOptions {
  return (
    typeof data === "object" &&
    data !== null &&
    "options" in data &&
    Array.isArray((data as RubricCheckDataWithOptions).options) &&
    (data as RubricCheckDataWithOptions).options.length > 0
  );
}

type CodeLineCommentContextType = {
  submission: SubmissionWithGraderResultsAndFiles;
  comments: SubmissionFileComment[];
  file: SubmissionFile;
  expanded: number[];
  close: (line: number) => void;
  open: (line: number) => void;
  showCommentsFeature: boolean;
  submissionReviewId?: number;
};

const CodeLineCommentContext = createContext<CodeLineCommentContextType | undefined>(undefined);

function useCodeLineCommentContext() {
  const context = useContext(CodeLineCommentContext);
  if (!context) {
    throw new Error("useCodeLineCommentContext must be used within a CodeLineCommentContext");
  }
  return context;
}


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

export type CodeFileHandle = {
  scrollToLine: (lineNumber: number) => void;
};

export type CodeFileProps = {
  file?: SubmissionFile;
  files?: SubmissionFile[];
  activeFileId?: number | null;
  onFileSelect?: (fileId: number) => void;
  openFileIds?: number[];
  onFileClose?: (fileId: number) => void;
};

const CodeFile = forwardRef<CodeFileHandle, CodeFileProps>(
  ({ file: singleFile, files, activeFileId, onFileSelect, openFileIds, onFileClose }, ref) => {
    const submission = useSubmission();
    const submissionReview = useActiveSubmissionReview();
    const showCommentsFeature = true;
    const { colorMode } = useColorMode();

    // Support both single file (legacy) and multi-file (new) modes
    const allFiles = useMemo(() => files || (singleFile ? [singleFile] : []), [files, singleFile]);
    
    // Determine which files are "open" (in tabs)
    const openFiles = useMemo(() => {
      if (openFileIds && openFileIds.length > 0) {
        return allFiles.filter((f) => openFileIds.includes(f.id));
      }
      // Default: show all files if no openFileIds specified
      return allFiles;
    }, [allFiles, openFileIds]);
    
    const currentFileId = activeFileId ?? (singleFile?.id ?? allFiles[0]?.id);
    const currentFile = useMemo(() => openFiles.find((f) => f.id === currentFileId) || openFiles[0], [openFiles, currentFileId]);

    const submissionController = useSubmissionController();
    const review = useActiveSubmissionReview();
    const { private_profile_id, public_profile_id } = useClassProfiles();
    const isGraderOrInstructor = useIsGraderOrInstructor();
    const graderPseudonymousMode = useGraderPseudonymousMode();
    const authorProfileId = isGraderOrInstructor && graderPseudonymousMode ? public_profile_id : private_profile_id;
    
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
    const [pendingScrollRestore, setPendingScrollRestore] = useState<{ topVisibleLine?: number; scrollTop?: number; scrollLeft: number } | null>(null);

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
    const restoreScrollPosition = useCallback((position: { topVisibleLine?: number; scrollTop?: number; scrollLeft: number } | null) => {
      if (!position) return;
      const editor = editorRef.current;
      if (editor) {
        if (position.topVisibleLine) {
          // Restore by revealing the same line at the top - this is more stable
          editor.revealLineInTop(position.topVisibleLine);
        } else if (position.scrollTop !== undefined) {
          // Fallback to absolute scroll position
          editor.setScrollTop(position.scrollTop);
        }
        editor.setScrollLeft(position.scrollLeft);
      }
    }, []);

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
      async (check: RubricCheck, criteria: RubricCriteria | undefined, startLine: number, endLine: number, subOption?: RubricCheckSubOption) => {
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
        await handleImmediateApply(
          action.check,
          action.criteria,
          startLine,
          endLine,
          action.subOption
        );
      },
      [handleImmediateApply]
    );

    // Handle add comment action
    const handleAddComment = useCallback((startLine: number, endLine: number) => {
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
    }, [saveScrollPosition]);

    const [expanded, setExpanded] = useState<number[]>([]);
    const [viewZoneNodes, setViewZoneNodes] = useState<Map<number, HTMLElement>>(new Map());
    const viewZoneNodesRef = useRef<Map<number, HTMLElement>>(new Map());
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const monacoRef = useRef<Monaco | null>(null);
    const modelsRef = useRef<Map<number, editor.ITextModel>>(new Map());
    const decorationsRef = useRef<Map<number, string[]>>(new Map());
    const viewZonesRef = useRef<Map<number, string>>(new Map());
    const viewZoneHeightsRef = useRef<Map<number, number>>(new Map());
    const highlightDecorationRef = useRef<string | null>(null);
    const symbolIndexRef = useRef<SymbolIndex | null>(null);
    const fileSymbolsRef = useRef<Map<number, JavaFileSymbols>>(new Map());
    const providerDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);
    
    // Sync viewZoneNodes state to ref for use in callbacks
    useEffect(() => {
      viewZoneNodesRef.current = viewZoneNodes;
    }, [viewZoneNodes]);
    
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
              
              // Fade out after 2 seconds
              setTimeout(() => {
                if (editorRef.current && highlightDecorationRef.current) {
                  editorRef.current.deltaDecorations([highlightDecorationRef.current], []);
                  highlightDecorationRef.current = null;
                }
              }, 2000);
            }
          }
        }
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
      (editor: editor.IStandaloneCodeEditor, monaco: Monaco, commentsByLineMap: Map<number, SubmissionFileComment[]>) => {
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
                glyphMarginHoverMessage: { value: `${lineComments.length} comment${lineComments.length > 1 ? "s" : ""}` },
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

    // Parse Java files and build symbol index
    useEffect(() => {
      const javaFiles = allFiles.filter((f) => f.name.endsWith(".java"));
      if (javaFiles.length === 0) return;

      const parsedSymbols: JavaFileSymbols[] = [];
      for (const file of javaFiles) {
        try {
          const parsed = parseJavaFile(file.contents, file.id, file.name);
          parsedSymbols.push(parsed);
          fileSymbolsRef.current.set(file.id, parsed);
        } catch (error) {
          console.warn(`Failed to parse Java file ${file.name}:`, error);
        }
      }

      if (parsedSymbols.length > 0) {
        symbolIndexRef.current = buildSymbolIndex(parsedSymbols);
      }
    }, [allFiles]);

    // Handle Monaco editor mount
    const handleEditorDidMount = useCallback(
      (editor: editor.IStandaloneCodeEditor, monaco: Monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;

        // Create models for all files
        allFiles.forEach((f) => {
          if (!modelsRef.current.has(f.id)) {
            const language = getMonacoLanguage(f.name);
            const model = monaco.editor.createModel(f.contents, language, monaco.Uri.parse(`file:///${f.name}`));
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

        // Register Java language providers if we have Java files
        const hasJavaFiles = allFiles.some((f) => f.name.endsWith(".java"));
        if (hasJavaFiles) {
          // Register definition provider
          const definitionProvider = monaco.languages.registerDefinitionProvider("java", {
            provideDefinition: (model, position) => {
              const word = model.getWordAtPosition(position);
              if (!word || !symbolIndexRef.current) return { definitions: [] };

              const fileName = model.uri.path.replace("file:///", "");
              const currentFile = allFiles.find((f) => f.name === fileName);
              if (!currentFile) return { definitions: [] };

              const currentFileData = fileSymbolsRef.current.get(currentFile.id);
              if (!currentFileData) return { definitions: [] };

              // Try to resolve the type
              const resolved = resolveType(word.word, currentFileData, symbolIndexRef.current);
              if (resolved) {
                const targetFile = allFiles.find((f) => f.id === resolved.fileId);
                if (targetFile) {
                  const targetModel = modelsRef.current.get(targetFile.id);
                  if (targetModel) {
                    return {
                      definitions: [
                        {
                          uri: targetModel.uri,
                          range: {
                            startLineNumber: resolved.line,
                            startColumn: resolved.column,
                            endLineNumber: resolved.line,
                            endColumn: resolved.column + resolved.name.length
                          }
                        }
                      ]
                    };
                  }
                }
              }

              // Fallback: find symbol by name
              const symbols = symbolIndexRef.current.byName.get(word.word) || [];
              if (symbols.length > 0) {
                const symbol = symbols[0];
                const targetFile = allFiles.find((f) => f.id === symbol.fileId);
                if (targetFile) {
                  const targetModel = modelsRef.current.get(targetFile.id);
                  if (targetModel) {
                    return {
                      definitions: [
                        {
                          uri: targetModel.uri,
                          range: {
                            startLineNumber: symbol.line,
                            startColumn: symbol.column,
                            endLineNumber: symbol.line,
                            endColumn: symbol.column + symbol.name.length
                          }
                        }
                      ]
                    };
                  }
                }
              }

              return { definitions: [] };
            }
          });
          providerDisposablesRef.current.push(definitionProvider);

          // Register reference provider
          const referenceProvider = monaco.languages.registerReferenceProvider("java", {
            provideReferences: (model, position) => {
              const word = model.getWordAtPosition(position);
              if (!word || !symbolIndexRef.current) return { references: [] };

              const symbols = symbolIndexRef.current.byName.get(word.word) || [];
              if (symbols.length === 0) return { references: [] };

              const symbol = symbols[0];
              const references = findReferences(
                symbol,
                symbolIndexRef.current,
                allFiles.map((f) => ({ id: f.id, contents: f.contents }))
              );

              return {
                references: references
                  .map((ref) => {
                    const targetFile = allFiles.find((f) => f.id === ref.fileId);
                    if (!targetFile) return null;
                    const targetModel = modelsRef.current.get(targetFile.id);
                    if (!targetModel) return null;

                    return {
                      uri: targetModel.uri,
                      range: {
                        startLineNumber: ref.line,
                        startColumn: ref.column,
                        endLineNumber: ref.line,
                        endColumn: ref.column + word.word.length
                      }
                    };
                  })
                  .filter((ref): ref is NonNullable<typeof ref> => ref !== null)
              };
            }
          });
          providerDisposablesRef.current.push(referenceProvider);

          // Register document symbol provider for "Go to Symbol" (Cmd+Shift+O)
          const documentSymbolProvider = monaco.languages.registerDocumentSymbolProvider("java", {
            provideDocumentSymbols: (model) => {
              // Early return if model or URI is invalid
              if (!model || !model.uri) {
                return [];
              }

              // Validate URI has required properties before proceeding
              let uri = model.uri;
              if (!uri || typeof uri.toString !== "function") {
                return [];
              }

              // Ensure URI has a scheme property - Monaco requires this
              // If scheme is missing, recreate URI with explicit scheme
              if (uri.scheme === undefined || uri.scheme === null) {
                try {
                  const uriString = uri.toString();
                  if (uriString && uriString.startsWith("file://")) {
                    // Extract path and recreate URI with explicit scheme
                    const path = uri.path || uri.fsPath || uriString.replace(/^file:\/\/\/+/, "");
                    uri = monaco.Uri.parse(`file:///${path}`);
                    // Verify new URI has scheme
                    if (uri.scheme !== "file") {
                      return [];
                    }
                  } else {
                    return [];
                  }
                } catch {
                  return [];
                }
              } else if (uri.scheme !== "file") {
                return [];
              }

              try {
                // Extract filename from URI - handle both path and fsPath
                const uriPath = uri.path || uri.fsPath || uri.toString().replace(/^file:\/\/\/+/, "");
                const fileName = uriPath.replace(/^\/+/, "").replace(/^file:\/\/\/+/, "");
                
                const currentFile = allFiles.find((f) => {
                  // Try exact match first
                  if (f.name === fileName) return true;
                  // Try matching just the filename part
                  const fileBaseName = f.name.split("/").pop();
                  const uriBaseName = fileName.split("/").pop();
                  return fileBaseName === uriBaseName;
                });
                
                if (!currentFile) {
                  return [];
                }

                const fileSymbols = fileSymbolsRef.current.get(currentFile.id);
                if (!fileSymbols || !fileSymbols.symbols || !Array.isArray(fileSymbols.symbols)) {
                  return [];
                }

                // Final check: ensure URI has scheme property before creating symbols
                if (uri.scheme !== "file") {
                  return [];
                }

                const symbols = fileSymbols.symbols
                  .filter((symbol) => symbol && symbol.name && symbol.line)
                  .map((symbol) => {
                    try {
                      const kindMap: Record<JavaSymbol["kind"], monaco.languages.SymbolKind> = {
                        class: monaco.languages.SymbolKind.Class,
                        interface: monaco.languages.SymbolKind.Interface,
                        enum: monaco.languages.SymbolKind.Enum,
                        method: monaco.languages.SymbolKind.Method,
                        constructor: monaco.languages.SymbolKind.Constructor,
                        field: monaco.languages.SymbolKind.Field
                      };

                      const kind = kindMap[symbol.kind] || monaco.languages.SymbolKind.Variable;
                      const detail = symbol.returnType
                        ? symbol.returnType
                        : symbol.parameters && Array.isArray(symbol.parameters) && symbol.parameters.length > 0
                          ? `(${symbol.parameters.join(", ")})`
                          : undefined;

                      // Critical: verify URI has scheme before creating location
                      if (!uri || uri.scheme !== "file") {
                        return null;
                      }

                      const location = {
                        uri: uri,
                        range: {
                          startLineNumber: Math.max(1, symbol.line || 1),
                          startColumn: Math.max(1, symbol.column || 1),
                          endLineNumber: Math.max(1, symbol.line || 1),
                          endColumn: Math.max(1, (symbol.column || 1) + (symbol.name?.length || 0))
                        }
                      };

                      // Final validation: ensure location.uri.scheme exists
                      if (!location.uri || !location.range || location.uri.scheme !== "file") {
                        return null;
                      }

                      return {
                        name: symbol.name || "",
                        kind,
                        location,
                        detail,
                        containerName: symbol.parent
                      };
                    } catch (err) {
                      return null;
                    }
                  })
                  .filter((s): s is NonNullable<typeof s> => s !== null);

                return symbols;
              } catch (error) {
                return [];
              }
            }
          });
          providerDisposablesRef.current.push(documentSymbolProvider);
        }

        // Update decorations when comments change
        updateGlyphDecorations(editor, monaco, commentsByLine);
        updateViewZones(editor, monaco, commentsByLine, expanded, currentFile);

        // Mouse down handler for glyph margin clicks (expand/collapse comments)
        editor.onMouseDown((e) => {
          const browserEvent = e.event.browserEvent;
          
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
      },
      [allFiles, currentFile, commentsByLine, expanded, updateGlyphDecorations, updateViewZones]
    );

    // Update decorations and view zones when comments or expanded state changes
    useEffect(() => {
      if (editorRef.current && monacoRef.current && currentFile) {
        updateGlyphDecorations(editorRef.current, monacoRef.current, commentsByLine);
        updateViewZones(editorRef.current, monacoRef.current, commentsByLine, expanded, currentFile);
      }
    }, [commentsByLine, expanded, currentFile, updateGlyphDecorations, updateViewZones]);

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
        models.forEach((model) => model.dispose());
        models.clear();
        decorations.clear();
        viewZones.clear();
        setViewZoneNodes(new Map());
        providerDisposables.forEach((disposable) => disposable.dispose());
        providerDisposables.length = 0;
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
        m={2}
        w="100%"
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
          }
        }}
      >
        {/* Tab bar for multiple files */}
        {openFiles.length > 1 && (
          <Flex
            w="100%"
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
                  bg={isActive ? "bg.default" : "bg.subtle"}
                  borderRight="1px solid"
                  borderColor="border.emphasized"
                  alignItems="center"
                  gap={1}
                  px={3}
                  py={2}
                  cursor="pointer"
                  _hover={{ bg: isActive ? "bg.default" : "bg.muted" }}
                  onClick={() => {
                    if (onFileSelect) {
                      onFileSelect(f.id);
                    }
                  }}
                  minW="fit-content"
                  position="relative"
                >
                  <Text fontSize="sm" fontWeight={isActive ? "semibold" : "normal"} noOfLines={1} maxW="200px">
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
            {showCommentsFeature && commentsForCurrentFile.length > 0 && (
              <>
                <Text fontSize="xs" color="text.subtle">
                  {commentsForCurrentFile.length} {commentsForCurrentFile.length === 1 ? "comment" : "comments"}
                </Text>
                <Tooltip
                  openDelay={300}
                  closeDelay={100}
                  content={expanded.length > 0 ? "Hide all comments" : "Expand all comments"}
                >
                  <Button
                    variant={expanded.length > 0 ? "solid" : "outline"}
                    size="xs"
                    p={0}
                    colorPalette="teal"
                    onClick={() => {
                      setExpanded((prev) => {
                        if (prev.length === 0) {
                          return allFileComments.map((comment) => comment.line);
                        }
                        return [];
                      });
                    }}
                  >
                    <Icon as={FaComments} m={0} />
                  </Button>
                </Tooltip>
              </>
            )}
          </HStack>
        </Flex>

        {/* Monaco Editor */}
        <Box height="600px" width="100%">
          <Editor
            height="600px"
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

CodeFile.displayName = "CodeFile";

// Portal component for rendering comments in view zones
function CodeLineCommentsPortal({ 
  lineNumber, 
  comments,
  onHeightChange 
}: { 
  lineNumber: number; 
  comments: SubmissionFileComment[];
  onHeightChange?: (height: number) => void;
}) {
  const {
    submission,
    showCommentsFeature,
    file,
    expanded,
    submissionReviewId
  } = useCodeLineCommentContext();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const isReplyEnabled = isGraderOrInstructor || submission.released !== null;
  const hasARegradeRequest = comments.some((comment) => comment.regrade_request_id !== null);
  const [showReply, setShowReply] = useState(isReplyEnabled);
  const containerRef = useRef<HTMLDivElement>(null);

  const commentsToDisplay = useMemo(() => {
    const ret = comments.filter((comment) => {
      if (!isGraderOrInstructor && submission.released !== null) {
        return comment.eventually_visible === true;
      }
      return true;
    });
    ret.sort((a, b) => {
      if (a.rubric_check_id && !b.rubric_check_id) return -1;
      if (!a.rubric_check_id && b.rubric_check_id) return 1;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    return ret;
  }, [comments, isGraderOrInstructor, submission.released]);

  // Update ViewZone height when content changes (debounced)
  useEffect(() => {
    if (!containerRef.current || !onHeightChange) return;
    
    let updateTimeout: NodeJS.Timeout;
    let rafId: number | null = null;
    
    const updateHeight = () => {
      const container = containerRef.current;
      if (!container) return;
      
      // Measure the actual content height
      const height = container.scrollHeight;
      onHeightChange(height + 20); // Add some padding
    };

    // Debounced update function
    const debouncedUpdate = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        clearTimeout(updateTimeout);
        updateTimeout = setTimeout(updateHeight, 100); // Debounce by 100ms
        rafId = null;
      });
    };

    // Initial update after render
    const initialTimeout = setTimeout(updateHeight, 50);
    
    // Also update when content might change (resize observer with debouncing)
    const resizeObserver = new ResizeObserver(() => {
      debouncedUpdate();
    });
    
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    return () => {
      clearTimeout(initialTimeout);
      clearTimeout(updateTimeout);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      resizeObserver.disconnect();
    };
  }, [commentsToDisplay, showReply, onHeightChange]);

  if (!submission || !file || !showCommentsFeature || commentsToDisplay.length === 0) {
    return null;
  }
  if (!expanded.includes(lineNumber)) {
    return null;
  }

  return (
    <Box
      ref={containerRef}
      width="100%"
      whiteSpace="normal"
      position="relative"
      m={0}
      borderTop="1px solid"
      borderBottom="1px solid"
      borderColor="border.emphasized"
      p={2}
    >
      <Box
        position="relative"
        maxW="xl"
        fontFamily={"sans-serif"}
        m={2}
        borderWidth="1px"
        borderColor="border.emphasized"
        borderRadius="md"
        p={2}
        backgroundColor="bg"
        boxShadow="sm"
      >
        {commentsToDisplay.map((comment) =>
          comment.rubric_check_id ? (
            <LineCheckAnnotation key={comment.id} comment_id={comment.id} />
          ) : (
            <CodeLineComment key={comment.id} comment_id={comment.id} />
          )
        )}
        {showReply && !hasARegradeRequest && (
          <LineCommentForm
            lineNumber={lineNumber}
            submission={submission}
            file={file}
            submissionReviewId={submissionReviewId}
          />
        )}
        {!showReply && !hasARegradeRequest && (
          <Box display="flex" justifyContent="flex-end">
            <Button colorPalette="green" onClick={() => setShowReply(true)}>
              Add Comment
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}

/**
 * Displays a rubric-based annotation comment on a code line, including points, rubric details, author, and visibility status.
 */
function LineCheckAnnotation({ comment_id }: { comment_id: number }) {
  const comment = useSubmissionFileComment(comment_id);
  const commentAuthor = useUserProfile(comment?.author);
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const submissionController = useSubmissionController();

  const isGraderOrInstructor = useIsGraderOrInstructor();

  const rubricCheck = useRubricCheck(comment?.rubric_check_id);
  const rubricCriteria = useRubricCriteria(rubricCheck?.rubric_criteria_id);

  if (!rubricCheck || !rubricCriteria || !comment) {
    return <Skeleton height="100px" width="100%" />;
  }

  const pointsText = rubricCriteria.is_additive ? `+${comment?.points}` : `-${comment?.points}`;
  const hasPoints = comment?.points !== 0 || (rubricCheck && rubricCheck.points !== 0);

  const getStudentVisibilityInfo = () => {
    if (!rubricCheck.student_visibility || rubricCheck.student_visibility === "always") {
      return { isVisible: true, reason: "Always visible to students" };
    }
    if (rubricCheck.student_visibility === "never") {
      return { isVisible: false, reason: "Never visible to students" };
    }
    if (rubricCheck.student_visibility === "if_applied") {
      return { isVisible: true, reason: "Visible to students when grades are released (check was applied)" };
    }
    if (rubricCheck.student_visibility === "if_released") {
      return { isVisible: true, reason: "Visible to students when grades are released" };
    }
    return { isVisible: true, reason: "Visible to students" };
  };

  const { isVisible: willBeVisibleToStudents } = getStudentVisibilityInfo();
  const canCreateRegradeRequest = !isGraderOrInstructor && hasPoints && !comment.regrade_request_id && comment.released;

  return (
    <Box role="region" aria-label={`Grading checks on line ${comment.line}`}>
      <RegradeRequestWrapper regradeRequestId={comment.regrade_request_id}>
        <Box m={0} p={0} w="100%" pb={1}>
          <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
            <PersonAvatar size="2xs" uid={comment.author} />
            <VStack alignItems="flex-start" spaceY={0} gap={0} w="100%" border="1px solid" borderRadius="md">
              <Box bg={willBeVisibleToStudents ? "bg.info" : "bg.error"} pl={1} pr={1} borderRadius="md" w="100%">
                <Flex w="100%" justifyContent="space-between">
                  <HStack flexGrow={10}>
                    {!comment.eventually_visible && (
                      <Tooltip content="This comment will never be visible to the student">
                        <Icon as={FaRegEyeSlash} color="fg.muted" />
                      </Tooltip>
                    )}
                    {comment.eventually_visible && !comment.released && (
                      <Tooltip content="This comment is not released to the student yet">
                        <Icon as={FaEyeSlash} />
                      </Tooltip>
                    )}
                    {hasPoints && (
                      <>
                        <Icon
                          as={rubricCriteria.is_additive ? FaCheckCircle : FaTimesCircle}
                          color={rubricCriteria.is_additive ? "green.500" : "red.500"}
                        />
                        {pointsText}
                      </>
                    )}
                    <Text fontSize="sm" color="fg.muted">
                      {rubricCriteria?.name} &gt; {rubricCheck?.name}
                    </Text>
                  </HStack>
                  <HStack gap={0} flexWrap="wrap">
                    <Text fontSize="sm" fontStyle="italic" color="fg.muted">
                      {commentAuthor?.name}
                      {isGraderOrInstructor && commentAuthor?.real_name && (
                        <Text as="span" fontSize="xs">
                          {" "}
                          ({commentAuthor.real_name})
                        </Text>
                      )}
                    </Text>
                    {comment.submission_review_id && (
                      <ReviewRoundTag submission_review_id={comment.submission_review_id} />
                    )}
                  </HStack>
                  <CommentActions comment={comment} setIsEditing={setIsEditing} />
                </Flex>
              </Box>
              <Box pl={2}>
                <Markdown style={{ fontSize: "0.8rem" }}>{rubricCheck.description}</Markdown>
              </Box>
              <Box pl={2} w="100%">
                {isEditing ? (
                  <MessageInput
                    textAreaRef={messageInputRef}
                    defaultSingleLine={true}
                    value={comment.comment}
                    closeButtonText="Cancel"
                    onClose={() => {
                      setIsEditing(false);
                    }}
                    sendMessage={async (message) => {
                      await submissionController.submission_file_comments.update(comment.id, { comment: message });
                      setIsEditing(false);
                    }}
                  />
                ) : (
                  <Markdown>{comment.comment}</Markdown>
                )}
              </Box>
              {canCreateRegradeRequest && <RequestRegradeDialog comment={comment} />}
            </VStack>
          </HStack>
        </Box>
      </RegradeRequestWrapper>
    </Box>
  );
}

/**
 * Renders a single general comment on a code line
 */
function CodeLineComment({ comment_id }: { comment_id: number }) {
  const comment = useSubmissionFileComment(comment_id);
  const authorProfile = useUserProfile(comment?.author);
  const isStaff = useIsGraderOrInstructor();
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const { mutateAsync: updateComment } = useUpdate({
    resource: "submission_file_comments"
  });

  if (!authorProfile || !comment) {
    return <Skeleton height="100px" width="100%" />;
  }

  const realNameSuffix = isStaff && authorProfile?.real_name ? ` (${authorProfile.real_name})` : "";

  return (
    <Box key={comment.id} m={0} pb={1} w="100%">
      <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
        <PersonAvatar size="2xs" uid={comment.author} />
        <VStack
          alignItems="flex-start"
          spaceY={0}
          gap={1}
          w="100%"
          border="1px solid"
          borderColor="border.emphasized"
          borderRadius="md"
        >
          <HStack
            w="100%"
            justifyContent="space-between"
            bg="bg.muted"
            p={0}
            borderTopRadius="md"
            borderBottom="1px solid"
            borderColor="border.emphasized"
          >
            <HStack gap={1} fontSize="sm" color="fg.muted" ml={1}>
              <Text fontWeight="bold">
                {authorProfile?.name}
                {realNameSuffix && (
                  <Text as="span" fontWeight="normal" color="fg.muted" fontSize="xs">
                    {realNameSuffix}
                  </Text>
                )}
              </Text>
              <Text data-visual-test="blackout">commented on {format(comment.created_at, "MMM d, yyyy")}</Text>
            </HStack>
            <HStack>
              {authorProfile?.flair ? (
                <Tag.Root size="md" colorPalette={authorProfile?.flair_color} variant="surface">
                  <Tag.Label>{authorProfile?.flair}</Tag.Label>
                </Tag.Root>
              ) : (
                <></>
              )}
              <CommentActions comment={comment} setIsEditing={setIsEditing} />
            </HStack>
          </HStack>
          <Box pl={2} w="100%">
            {isEditing ? (
              <MessageInput
                textAreaRef={messageInputRef}
                defaultSingleLine={true}
                value={comment.comment}
                closeButtonText="Cancel"
                onClose={() => {
                  setIsEditing(false);
                }}
                sendMessage={async (message) => {
                  await updateComment({ id: comment.id, values: { comment: message } });
                  setIsEditing(false);
                }}
              />
            ) : (
              <Markdown>{comment.comment}</Markdown>
            )}
          </Box>
        </VStack>
      </HStack>
    </Box>
  );
}

export type RubricCriteriaSelectGroupOption = {
  readonly label: string;
  readonly value: string;
  readonly options: readonly RubricCheckSelectOption[];
  readonly criteria?: RubricCriteria;
};

export type RubricCheckSelectOption = {
  readonly label: string;
  readonly value: string;
  readonly check?: RubricCheck;
  readonly criteria?: RubricCriteria;
  options?: RubricCheckSubOptions[];
  isDisabled?: boolean;
};

export type RubricCheckSubOptions = {
  readonly label: string;
  readonly index: string;
  readonly value: string;
  readonly comment: string;
  readonly points: number;
  readonly check: RubricCheckSelectOption;
  isDisabled?: boolean;
};

export function formatPoints(option: { check?: RubricCheck; criteria?: RubricCriteria; points: number }) {
  if (option.check && option.criteria) {
    return `Points: ${option.criteria.is_additive ? "+" : "-"}${option.points}`;
  }
  return ``;
}


export default CodeFile;
