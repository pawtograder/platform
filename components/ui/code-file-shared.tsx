"use client";

import { Tooltip } from "@/components/ui/tooltip";
import { useRubricCheck, useRubricCriteria } from "@/hooks/useAssignment";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useSubmissionController, useSubmissionFileComment } from "@/hooks/useSubmission";
import { useUserProfile } from "@/hooks/useUserProfiles";
import {
  Json,
  RubricCheck,
  RubricCriteria,
  SubmissionFile,
  SubmissionFileComment,
  SubmissionWithGraderResultsAndFiles
} from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex, HStack, Icon, Tag, Text, VStack } from "@chakra-ui/react";
import { useUpdate } from "@refinedev/core";
import { format } from "date-fns";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FaCheckCircle, FaEyeSlash, FaRegEyeSlash, FaTimesCircle } from "react-icons/fa";
import LineCommentForm from "./line-comments-form";
import Markdown from "./markdown";
import MessageInput from "./message-input";
import PersonAvatar from "./person-avatar";
import RegradeRequestWrapper from "./regrade-request-wrapper";
import RequestRegradeDialog from "./request-regrade-dialog";
import { CommentActions, ReviewRoundTag } from "./rubric-sidebar";
import { Skeleton } from "./skeleton";

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

export const CodeLineCommentContext = createContext<CodeLineCommentContextType | undefined>(undefined);

export function useCodeLineCommentContext() {
  const context = useContext(CodeLineCommentContext);
  if (!context) {
    throw new Error("useCodeLineCommentContext must be used within a CodeLineCommentContext");
  }
  return context;
}

export function CodeLineCommentsPortal({
  lineNumber,
  comments,
  onHeightChange
}: {
  lineNumber: number;
  comments: SubmissionFileComment[];
  onHeightChange?: (height: number) => void;
}) {
  const { submission, showCommentsFeature, file, expanded, submissionReviewId } = useCodeLineCommentContext();
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
