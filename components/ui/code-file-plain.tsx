"use client";

import { Tooltip } from "@/components/ui/tooltip";
import { useGraderPseudonymousMode } from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useSubmission, useSubmissionController, useSubmissionFileComments } from "@/hooks/useSubmission";
import { useActiveSubmissionReview } from "@/hooks/useSubmissionReview";
import { RubricCheck, RubricCriteria, SubmissionFileComment } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Button, Flex, HStack, Icon, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";
import { FaComments, FaTimes } from "react-icons/fa";
import { AnnotationCommentDialog } from "./annotation-comment-dialog";
import {
  CodeLineCommentContext,
  CodeLineCommentsPortal,
  RubricCheckSubOption,
  type CodeFileHandle,
  type CodeFileProps
} from "./code-file-shared";
import { RubricContextMenuAction } from "./monaco-rubric-context-menu";
import { PlainRubricLineMenu } from "./plain-rubric-line-menu";
import { Skeleton } from "./skeleton";
import { toaster } from "./toaster";

export type { CodeFileHandle, CodeFileProps };

const CodeFilePlain = forwardRef<CodeFileHandle, CodeFileProps>(
  ({ file: singleFile, files, activeFileId, onFileSelect, openFileIds, onFileClose }, ref) => {
    const submission = useSubmission();
    const submissionReview = useActiveSubmissionReview();
    const showCommentsFeature = true;

    const allFiles = useMemo(() => files || (singleFile ? [singleFile] : []), [files, singleFile]);

    const openFiles = useMemo(() => {
      if (openFileIds && openFileIds.length > 0) {
        return allFiles.filter((f) => openFileIds.includes(f.id));
      }
      return allFiles;
    }, [allFiles, openFileIds]);

    const currentFileId = activeFileId ?? singleFile?.id ?? allFiles[0]?.id;
    const currentFile = useMemo(
      () => openFiles.find((f) => f.id === currentFileId) || openFiles[0],
      [openFiles, currentFileId]
    );

    const submissionController = useSubmissionController();
    const review = useActiveSubmissionReview();
    const { private_profile_id, public_profile_id } = useClassProfiles();
    const isGraderOrInstructor = useIsGraderOrInstructor();
    const graderPseudonymousMode = useGraderPseudonymousMode();
    const authorProfileId = isGraderOrInstructor && graderPseudonymousMode ? public_profile_id : private_profile_id;

    const [commentDialogState, setCommentDialogState] = useState<{
      isOpen: boolean;
      startLine: number;
      endLine: number;
      rubricCheck?: RubricCheck;
      criteria?: RubricCriteria;
      subOptionComment?: string;
      subOptionPoints?: number;
    }>({
      isOpen: false,
      startLine: 1,
      endLine: 1
    });

    const [pendingScrollRestore, setPendingScrollRestore] = useState<{
      scrollTop?: number;
      scrollLeft: number;
    } | null>(null);

    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const [highlightLine, setHighlightLine] = useState<number | null>(null);

    const saveScrollPosition = useCallback(() => {
      const el = scrollContainerRef.current;
      if (!el) return null;
      return { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft };
    }, []);

    const restoreScrollPosition = useCallback((position: { scrollTop?: number; scrollLeft: number } | null) => {
      if (!position) return;
      const el = scrollContainerRef.current;
      if (!el) return;
      if (position.scrollTop !== undefined) el.scrollTop = position.scrollTop;
      el.scrollLeft = position.scrollLeft;
    }, []);

    const handleSelectCheck = useCallback(
      async (action: RubricContextMenuAction, startLine: number, endLine: number) => {
        if (!action.check || !currentFile || !submission) return;

        const check = action.check;
        const criteria = action.criteria;
        const subOption = action.subOption;

        const savedScrollPosition = saveScrollPosition();
        if (savedScrollPosition) {
          setPendingScrollRestore(savedScrollPosition);
        }

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

    const handleImmediateApplyFromMenu = useCallback(
      async (action: RubricContextMenuAction, startLine: number, endLine: number) => {
        if (!action.check) return;
        await handleImmediateApply(action.check, action.criteria, startLine, endLine, action.subOption);
      },
      [handleImmediateApply]
    );

    const handleAddComment = useCallback(
      (startLine: number, endLine: number) => {
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

    const [expanded, setExpanded] = useState<number[]>([]);

    useImperativeHandle(ref, () => ({
      scrollToLine: (lineNumber: number) => {
        if (lineNumber <= 0) return;
        const el = document.getElementById(`plain-line-${lineNumber}`);
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        setHighlightLine(lineNumber);
        window.setTimeout(() => setHighlightLine(null), 2000);
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

    const allFileComments = useMemo(() => {
      if (!currentFile) return [];
      return _comments.filter((comment) => comment.submission_file_id === currentFile.id);
    }, [_comments, currentFile]);

    const commentsByLine = useMemo(() => {
      const grouped = new Map<number, SubmissionFileComment[]>();
      allFileComments.forEach((comment) => {
        const existing = grouped.get(comment.line) || [];
        grouped.set(comment.line, [...existing, comment]);
      });
      return grouped;
    }, [allFileComments]);

    useEffect(() => {
      if (pendingScrollRestore && scrollContainerRef.current) {
        requestAnimationFrame(() => {
          if (scrollContainerRef.current && pendingScrollRestore) {
            restoreScrollPosition(pendingScrollRestore);
            setPendingScrollRestore(null);
          }
        });
      }
    }, [commentsByLine, expanded, pendingScrollRestore, restoreScrollPosition]);

    const lines = useMemo(() => {
      if (!currentFile) return [];
      return (currentFile.contents ?? "").split(/\r?\n/);
    }, [currentFile]);

    const commentsForCurrentFile = useMemo(() => {
      if (!currentFile) return [];
      return allFileComments.filter((c) => expanded.includes(c.line));
    }, [allFileComments, expanded, currentFile]);

    const toggleLineExpanded = useCallback(
      (lineNumber: number) => {
        const hasComments = (commentsByLine.get(lineNumber)?.length ?? 0) > 0;
        if (!hasComments) return;
        setExpanded((prev) =>
          prev.includes(lineNumber) ? prev.filter((l) => l !== lineNumber) : [...prev, lineNumber]
        );
      },
      [commentsByLine]
    );

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
          "& .plain-line-highlight": {
            backgroundColor: "rgba(255, 235, 59, 0.25)",
            transition: "background-color 2s ease-out"
          }
        }}
      >
        {openFiles.length > 1 && (
          <Flex
            w="100%"
            bg="bg.subtle"
            borderBottom="1px solid"
            borderColor="border.emphasized"
            alignItems="stretch"
            overflowX="auto"
            css={{
              "&::-webkit-scrollbar": { height: "6px" },
              "&::-webkit-scrollbar-track": { background: "transparent" },
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
            {currentFile.name} (plain view — Monaco disabled in your preferences)
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

        <CodeLineCommentContext.Provider
          value={{
            submission,
            comments: allFileComments,
            file: currentFile,
            expanded,
            open: (line: number) => {
              setExpanded((prev) => (prev.includes(line) ? prev : [...prev, line]));
            },
            close: (line: number) => {
              setExpanded((prev) => prev.filter((l) => l !== line));
            },
            showCommentsFeature,
            submissionReviewId: submissionReview?.id
          }}
        >
          <Box ref={scrollContainerRef} maxH="600px" overflow="auto" w="100%">
            {lines.map((lineText, i) => {
              const lineNumber = i + 1;
              const lineComments = commentsByLine.get(lineNumber);
              const hasComments = lineComments && lineComments.length > 0;
              const isExpanded = expanded.includes(lineNumber);

              return (
                <Box key={`${currentFile.id}-L${lineNumber}`}>
                  <Flex
                    id={`plain-line-${lineNumber}`}
                    className={highlightLine === lineNumber ? "plain-line-highlight" : undefined}
                    borderBottom="1px solid"
                    borderColor="border.subtle"
                    minH="1.5em"
                    align="stretch"
                    cursor={hasComments ? "pointer" : "default"}
                    onClick={() => toggleLineExpanded(lineNumber)}
                    _hover={hasComments ? { bg: "bg.muted" } : undefined}
                  >
                    <Box
                      flexShrink={0}
                      w="52px"
                      textAlign="right"
                      pr={2}
                      pt={0.5}
                      fontSize="xs"
                      color="fg.muted"
                      userSelect="none"
                      borderRight="1px solid"
                      borderColor="border.subtle"
                    >
                      {lineNumber}
                      {hasComments && (
                        <Text as="span" ml={1} fontSize="10px">
                          💬
                        </Text>
                      )}
                    </Box>
                    <Box
                      flex={1}
                      pl={2}
                      py={0.5}
                      fontFamily="mono"
                      fontSize="sm"
                      whiteSpace="pre-wrap"
                      wordBreak="break-word"
                    >
                      {lineText || " "}
                    </Box>
                  </Flex>

                  {hasComments && isExpanded && (
                    <Box pl="52px" borderBottom="1px solid" borderColor="border.emphasized">
                      <PlainRubricLineMenu
                        file={currentFile}
                        lineNumber={lineNumber}
                        onSelectCheck={handleSelectCheck}
                        onImmediateApply={handleImmediateApplyFromMenu}
                        onAddComment={handleAddComment}
                      />
                      <CodeLineCommentsPortal lineNumber={lineNumber} comments={lineComments!} />
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        </CodeLineCommentContext.Provider>

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
      </Box>
    );
  }
);

CodeFilePlain.displayName = "CodeFilePlain";

export default CodeFilePlain;
