"use client";

import { Tooltip } from "@/components/ui/tooltip";
import {
  useRubricCheck,
  useRubricCriteria,
  useRubricChecksByRubric,
  useRubricCriteriaByRubric
} from "@/hooks/useAssignment";
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
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Icon,
  NativeSelectField,
  NativeSelectRoot,
  Tag,
  Text,
  VStack
} from "@chakra-ui/react";
import { useUpdate } from "@refinedev/core";
import { format } from "date-fns";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FaCheckCircle, FaEyeSlash, FaPlus, FaRegEyeSlash, FaTimes, FaTimesCircle } from "react-icons/fa";
import { GroupMemberLabelText } from "./group-member-select-option";
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
  /**
   * All submission files, for the language layer to index and to create models for cross-file
   * go-to-definition targets. Independent of `files`/tabs — does not change what is displayed.
   */
  indexFiles?: SubmissionFile[];
  /** Invoked when go-to-definition lands in a different file, so the host can switch the active file. */
  onNavigateToFile?: (fileId: number) => void;
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
  const { submission, showCommentsFeature, file, expanded, close, submissionReviewId } = useCodeLineCommentContext();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const hasARegradeRequest = comments.some((comment) => comment.regrade_request_id !== null);
  // Default to a compact, read-only view of existing comments; the full add-comment form only mounts
  // once the grader clicks "Add comment" so the overlay stays small while skimming.
  const [showReply, setShowReply] = useState(false);
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
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id - b.id;
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
      onHeightChange(height + 8); // Add a little padding
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
      p={1}
    >
      <Box
        position="relative"
        maxW="xl"
        fontFamily={"sans-serif"}
        m={1}
        borderWidth="1px"
        borderColor="border.emphasized"
        borderRadius="md"
        p={1}
        backgroundColor="bg"
        boxShadow="sm"
      >
        {/* Per-overlay dismiss as a flow header row inside the comment card — right-aligned to the card
            (not the full, possibly-scrolled zone width, which pushed it off-screen) and above the
            comments so it never overlaps a comment's own action menu. Collapses just this line. */}
        <Flex justify="flex-end" mb={1}>
          <Tooltip openDelay={300} closeDelay={100} content="Hide comments on this line">
            <Button
              aria-label="Hide comments on this line"
              size="2xs"
              variant="ghost"
              colorPalette="gray"
              minW="auto"
              h="auto"
              p={1}
              onClick={() => close(lineNumber)}
            >
              <Icon as={FaTimes} />
            </Button>
          </Tooltip>
        </Flex>
        <VStack align="stretch" gap={1}>
          {commentsToDisplay.map((comment) =>
            comment.rubric_check_id ? (
              <LineCheckAnnotation key={comment.id} comment_id={comment.id} />
            ) : (
              <CodeLineComment key={comment.id} comment_id={comment.id} />
            )
          )}
        </VStack>
        {showReply && !hasARegradeRequest && (
          <LineCommentForm
            lineNumber={lineNumber}
            submission={submission}
            file={file}
            submissionReviewId={submissionReviewId}
            onCancel={() => setShowReply(false)}
            onSubmitted={() => setShowReply(false)}
          />
        )}
        {!showReply && !hasARegradeRequest && (
          <Box display="flex" justifyContent="flex-end" mt={1}>
            <Button size="2xs" variant="ghost" colorPalette="green" onClick={() => setShowReply(true)}>
              <Icon as={FaPlus} /> Add comment
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}

/**
 * In-place score editor for an applied rubric check (issue #307).
 *
 * A grader may only choose a score that is **associated with the selected check** — never an arbitrary
 * number. So this only renders when the check defines sub-options, and it offers exactly those options.
 * For a single-value check the score is fixed by the check and there is nothing to edit (this returns
 * null). `is_additive` only drives the sign shown; the stored value is the positive magnitude.
 */
function CheckScoreEditor({
  rubricCheck,
  rubricCriteria,
  points,
  onChange
}: {
  rubricCheck: RubricCheck;
  rubricCriteria: RubricCriteria;
  points: number;
  onChange: (option: { points: number; label: string }) => void;
}) {
  if (!isRubricCheckDataWithOptions(rubricCheck.data)) {
    return null;
  }

  const sign = rubricCriteria.is_additive ? "+" : "-";
  const options = rubricCheck.data.options;
  const selectedIdx = options.findIndex((o) => o.points === points);

  return (
    <HStack gap={1}>
      <Text fontSize="sm" color="fg.muted">
        Score:
      </Text>
      <NativeSelectRoot size="sm" width="auto">
        <NativeSelectField
          aria-label="Edit check score"
          value={String(selectedIdx)}
          onChange={(e) => {
            const opt = options[Number(e.target.value)];
            if (opt) onChange({ points: opt.points, label: opt.label });
          }}
        >
          {options.map((opt, idx) => (
            <option key={idx} value={String(idx)}>
              {sign}
              {opt.points} {opt.label}
            </option>
          ))}
        </NativeSelectField>
      </NativeSelectRoot>
    </HStack>
  );
}

/** The default points a check applies when (re)assigned: a single-value check's points, or the first
 * sub-option's points for a multi-option check (the grader can then refine via CheckScoreEditor). */
function defaultPointsForCheck(check: RubricCheck): number {
  if (isRubricCheckDataWithOptions(check.data)) {
    return check.data.options[0]?.points ?? 0;
  }
  return check.points ?? 0;
}

/**
 * Lets a grader change WHICH rubric check an annotation comment is associated with (within the same
 * rubric), grouped by criteria. Picking a different check reassigns `rubric_check_id` and resets
 * `points` to that check's default — the score control then offers the new check's options.
 */
function CheckSelector({
  currentCheckId,
  rubricId,
  onChange
}: {
  currentCheckId: number;
  rubricId: number;
  onChange: (args: { rubricCheckId: number; points: number }) => void;
}) {
  const checks = useRubricChecksByRubric(rubricId);
  const criteria = useRubricCriteriaByRubric(rubricId);

  const groups = useMemo(() => {
    const annotationChecks = checks.filter((c) => c.is_annotation);
    return criteria
      .filter((cr) => annotationChecks.some((c) => c.rubric_criteria_id === cr.id))
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((cr) => ({
        criteria: cr,
        checks: annotationChecks.filter((c) => c.rubric_criteria_id === cr.id).sort((a, b) => a.ordinal - b.ordinal)
      }));
  }, [checks, criteria]);

  if (groups.length === 0) return null;

  return (
    <HStack gap={1}>
      <Text fontSize="sm" color="fg.muted">
        Check:
      </Text>
      <NativeSelectRoot size="sm" width="auto">
        <NativeSelectField
          aria-label="Change rubric check"
          value={String(currentCheckId)}
          onChange={(e) => {
            const id = Number(e.target.value);
            if (id === currentCheckId) return;
            const next = checks.find((c) => c.id === id);
            if (next) onChange({ rubricCheckId: id, points: defaultPointsForCheck(next) });
          }}
        >
          {groups.map((g) => (
            <optgroup key={g.criteria.id} label={g.criteria.name}>
              {g.checks.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                  {!isRubricCheckDataWithOptions(c.data) ? ` (${g.criteria.is_additive ? "+" : "-"}${c.points})` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelectField>
      </NativeSelectRoot>
    </HStack>
  );
}

/**
 * Displays a rubric-based annotation comment on a code line, including points, rubric details, author,
 * and visibility status. Single shared implementation consumed by all editor variants (Monaco, plain,
 * and starry-night) so the score-edit behavior lands everywhere from one place.
 *
 * Graders/instructors can edit the comment AND the score in place (issue #307): clicking "Edit" reveals
 * a score control alongside the comment box, and saving persists both — no more delete-and-reapply to
 * change a score. Editing is gated by `CommentActions` (which encodes the author/release/role rules), so
 * the editor only appears when editing is actually permitted.
 */
export function LineCheckAnnotation({ comment_id }: { comment_id: number }) {
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
  // The score can only be changed among the check's own sub-options — never an arbitrary number — so
  // the editor is offered only for checks that define options (and not while a regrade is pending).
  const isScoreEditable = !comment.regrade_request_id && isRubricCheckDataWithOptions(rubricCheck.data);

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
                    {comment.target_student_profile_id && (
                      <Badge variant="outline" fontSize="xs" flexShrink={0}>
                        <GroupMemberLabelText profileId={comment.target_student_profile_id} />
                      </Badge>
                    )}
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
                  <VStack align="stretch" gap={2} w="100%">
                    {/*
                      Check association, score, and comment are independent and each persists
                      immediately on change (issue #307): a grader can reassign the check, adjust the
                      score, or edit the text without re-saving the others. Reassigning the check also
                      resets the points to the new check's default (and re-points the score control).
                    */}
                    {!comment.regrade_request_id && (
                      <CheckSelector
                        currentCheckId={rubricCheck.id}
                        rubricId={rubricCriteria.rubric_id}
                        onChange={({ rubricCheckId, points }) => {
                          void submissionController.submission_file_comments.update(comment.id, {
                            rubric_check_id: rubricCheckId,
                            points
                          });
                        }}
                      />
                    )}
                    {isScoreEditable && (
                      <CheckScoreEditor
                        rubricCheck={rubricCheck}
                        rubricCriteria={rubricCriteria}
                        points={comment.points ?? 0}
                        onChange={({ points }) => {
                          void submissionController.submission_file_comments.update(comment.id, { points });
                        }}
                      />
                    )}
                    <MessageInput
                      textAreaRef={messageInputRef}
                      defaultSingleLine={true}
                      value={comment.comment}
                      closeButtonText="Cancel"
                      allowEmptyMessage={true}
                      onClose={() => {
                        setIsEditing(false);
                      }}
                      sendMessage={async (message) => {
                        await submissionController.submission_file_comments.update(comment.id, { comment: message });
                        setIsEditing(false);
                      }}
                    />
                  </VStack>
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
export function CodeLineComment({ comment_id }: { comment_id: number }) {
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
