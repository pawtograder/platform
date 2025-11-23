import { Tooltip } from "@/components/ui/tooltip";
import {
  useRubricCheck,
  useRubricChecksByRubric,
  useRubricCriteria,
  useRubricCriteriaByRubric,
  useRubricWithParts
} from "@/hooks/useAssignment";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
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
import { common, createStarryNight } from "@wooorm/starry-night";
import "@wooorm/starry-night/style/both";
import { chakraComponents, Select, SelectComponentsConfig, SelectInstance } from "chakra-react-select";
import { format } from "date-fns";
import { Element, ElementContent, Properties, Root, RootContent } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import {
  createContext,
  Dispatch,
  SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType
} from "react";
import { FaCheckCircle, FaComments, FaEyeSlash, FaRegComment, FaRegEyeSlash, FaTimesCircle } from "react-icons/fa";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import LineCommentForm from "./line-comments-form";
import Markdown from "./markdown";
import MessageInput from "./message-input";
import PersonAvatar from "./person-avatar";
import RegradeRequestWrapper from "./regrade-request-wrapper";
import RequestRegradeDialog from "./request-regrade-dialog";
import { RubricMarkingMenu } from "./rubric-marking-menu";
import { CommentActions, ReviewRoundTag, StudentVisibilityIndicator } from "./rubric-sidebar";
import { Skeleton } from "./skeleton";
import { toaster } from "./toaster";

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

export type LineActionPopupDynamicProps = {
  lineNumber: number;
  top: number;
  left: number;
  visible: boolean;
  onClose?: () => void;
  close: () => void;
  mode: "marking" | "select";
};

type LineActionPopupComponentProps = LineActionPopupDynamicProps & {
  file: SubmissionFile;
};

export default function CodeFile({ file }: { file: SubmissionFile }) {
  const submission = useSubmission();
  const submissionReview = useActiveSubmissionReview();
  const showCommentsFeature = true; //submission.released !== null || submissionReview !== undefined;

  const [starryNight, setStarryNight] = useState<Awaited<ReturnType<typeof createStarryNight>> | undefined>(undefined);
  const [lineActionPopupProps, setLineActionPopupProps] = useState<LineActionPopupDynamicProps>(() => ({
    lineNumber: 0,
    top: 0,
    left: 0,
    visible: false,
    mode: "select",
    close: () => { }
  }));

  const [expanded, setExpanded] = useState<number[]>([]);

  const onCommentsEnter = useCallback(
    (newlyEnteredComments: SubmissionFileComment[]) => {
      if (showCommentsFeature) {
        setExpanded((currentExpanded) => {
          const linesFromNewComments = newlyEnteredComments.map((comment) => comment.line);
          const linesToAdd = linesFromNewComments.filter((line) => !currentExpanded.includes(line));
          if (linesToAdd.length > 0) {
            return [...currentExpanded, ...linesToAdd];
          }
          return currentExpanded; // Return current state if no change
        });
      }
    },
    [showCommentsFeature]
  );

  const _comments = useSubmissionFileComments({
    file_id: file.id,
    onEnter: onCommentsEnter
  });
  const comments = useMemo(() => {
    return _comments.filter((comment) => expanded.includes(comment.line));
  }, [_comments, expanded]);

  useEffect(() => {
    async function highlight() {
      const highlighter = await createStarryNight(common);
      setStarryNight(highlighter);
    }
    highlight();
  }, []);
  if (!starryNight || !file) {
    return <Skeleton />;
  }
  const tree = starryNight.highlight(file.contents, "source.java");
  starryNightGutter(tree, setLineActionPopupProps);
  const reactNode = toJsxRuntime(tree, {
    Fragment,
    jsx,
    jsxs,
    components: {
      CodeLineComments: CodeLineComments,
      LineNumber: LineNumber
    } as Record<string, ComponentType<{ lineNumber: number }>>
  });
  const commentsCSS = showCommentsFeature
    ? {
      "& .source-code-line": {
        cursor: "pointer",
        display: "flex",
        flexDirection: "row",
        "&:hover": {
          bg: "yellow.subtle",
          width: "100%",
          cursor: "cell"
        }
      },
      "& .selected": {
        bg: "yellow.subtle"
      }
    }
    : {
      "& .source-code-line": {
        display: "flex",
        flexDirection: "row"
      }
    };
  return (
    <Box
      border="1px solid"
      borderColor="border.emphasized"
      p={0}
      m={2}
      w="100%"
      css={{
        ...commentsCSS,
        "& .line-number": {
          width: "40px",
          textAlign: "right",
          padding: "0 5px",
          marginRight: "10px",
          borderRight: "1px solid #ccc"
        },
        "& .source-code-line-container": {
          width: "100%"
        },
        "& .source-code-line-content": {},
        "& pre": {
          whiteSpace: "pre-wrap",
          wordWrap: "break-word"
        }
      }}
    >
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
          {file.name}
        </Text>
        <HStack>
          {showCommentsFeature && comments.length > 0 && (
            <>
              <Text fontSize="xs" color="text.subtle">
                {comments.length} {comments.length === 1 ? "comment" : "comments"}
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
                        return comments.map((comment) => comment.line);
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
      {/* Pass dynamic props from state, and other props directly */}
      <LineActionPopup {...lineActionPopupProps} file={file} />
      <CodeLineCommentContext.Provider
        value={{
          submission,
          comments,
          file,
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
        <VStack
          gap={0}
          onClick={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            setLineActionPopupProps((prev) => {
              prev.onClose?.();
              return {
                ...prev,
                visible: false,
                onClose: undefined
              };
            });
          }}
        >
          {reactNode}
        </VStack>
      </CodeLineCommentContext.Provider>
    </Box>
  );
}

/**
 * @param {Root} tree
 *   Tree.
 * @returns {undefined}
 *   Nothing.
 */
export function starryNightGutter(
  tree: Root,
  setLineActionPopup: Dispatch<SetStateAction<LineActionPopupDynamicProps>>
) {
  const replacement: RootContent[] = [];
  const search = /\r?\n|\r/g;
  let index = -1;
  let start = 0;
  let startTextRemainder = "";
  let lineNumber = 0;

  while (++index < tree.children.length) {
    const child = tree.children[index];

    if (child.type === "text") {
      let textStart = 0;
      let match = search.exec(child.value);

      while (match) {
        // Nodes in this line.
        const line = /** @type {Array<ElementContent>} */ tree.children.slice(start, index);

        // Prepend text from a partial matched earlier text.
        if (startTextRemainder) {
          line.unshift({ type: "text", value: startTextRemainder });
          startTextRemainder = "";
        }

        // Append text from this text.
        if (match.index > textStart) {
          line.push({
            type: "text",
            value: child.value.slice(textStart, match.index)
          });
        }

        // Add a line, and the eol.
        lineNumber += 1;
        replacement.push(createLine(line as ElementContent[], lineNumber, setLineActionPopup), {
          type: "text",
          value: match[0]
        });

        start = index + 1;
        textStart = match.index + match[0].length;
        match = search.exec(child.value);
      }

      // If we matched, make sure to not drop the text after the last line ending.
      if (start === index + 1) {
        startTextRemainder = child.value.slice(textStart);
      }
    }
  }

  const line = /** @type {Array<ElementContent>} */ tree.children.slice(start);
  // Prepend text from a partial matched earlier text.
  if (startTextRemainder) {
    line.unshift({ type: "text", value: startTextRemainder });
    startTextRemainder = "";
  }

  if (line.length > 0) {
    lineNumber += 1;
    replacement.push(createLine(line as ElementContent[], lineNumber, setLineActionPopup));
  }

  // Replace children with new array.
  tree.children = replacement;
}

/**
 * Displays a rubric-based annotation comment on a code line, including points, rubric details, author, and visibility status.
 *
 * Allows inline editing of the comment for graders and instructors. If the user is a student and the comment affects their score, provides a dialog to request a regrade, with special handling for group submissions. Shows relevant UI elements based on comment visibility, release status, and regrade request state.
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

  // Determine if this comment will be visible to students
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

  // Check if student can create a regrade request
  const canCreateRegradeRequest = !isGraderOrInstructor && hasPoints && !comment.regrade_request_id && comment.released;

  // Check if this is a group submission

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
              {/* Regrade Request Button */}
              {canCreateRegradeRequest && <RequestRegradeDialog comment={comment} />}
            </VStack>
          </HStack>
        </Box>
      </RegradeRequestWrapper>
    </Box>
  );
}

/**
 * Renders a single general comment on a code line, displaying the author's profile, flair, and comment content, with inline editing capabilities.
 *
 * If the comment or author profile is not yet loaded, displays a loading skeleton.
 *
 * @param comment_id - The ID of the comment to display.
 * @param submissionReviewId - Optional ID of the submission review, used for context.
 */
function CodeLineComment({ comment_id }: { comment_id: number }) {
  const comment = useSubmissionFileComment(comment_id);
  const authorProfile = useUserProfile(comment?.author);
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const { mutateAsync: updateComment } = useUpdate({
    resource: "submission_file_comments"
  });

  if (!authorProfile || !comment) {
    return <Skeleton height="100px" width="100%" />;
  }

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
              <Text fontWeight="bold">{authorProfile?.name}</Text>
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

/**
 * Displays a popup for annotating a specific line in a code file with a rubric check or comment.
 *
 * Allows graders to select a rubric check (with optional sub-options), view criteria, and add an optional or required comment to the selected line. Enforces annotation limits per check and provides context-sensitive UI for marking or direct selection modes. Handles submission of new annotation comments, including points and visibility settings.
 */
function LineActionPopup({ lineNumber, top, left, visible, close, mode, file }: LineActionPopupComponentProps) {
  const submissionController = useSubmissionController();
  const submission = useSubmission();
  const review = useActiveSubmissionReview();
  const rubric = useRubricWithParts(review?.rubric_id);
  const [selectOpen, setSelectOpen] = useState(true);

  const [selectedCheckOption, setSelectedCheckOption] = useState<RubricCheckSelectOption | null>(null);
  const [selectedSubOption, setSelectedSubOption] = useState<RubricCheckSubOptions | null>(null);
  const selectRef = useRef<SelectInstance<RubricCheckSelectOption, false, RubricCriteriaSelectGroupOption>>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [currentMode, setCurrentMode] = useState<"marking" | "select">(mode);

  useEffect(() => {
    if (!selectedCheckOption) {
      setSelectOpen(true);
    }
  }, [selectedCheckOption]);

  // Get existing comments for this file to check max_annotations
  const existingComments = useSubmissionFileComments({ file_id: file.id });
  const rubricCriteria = useRubricCriteriaByRubric(rubric?.id);
  const rubricChecks = useRubricChecksByRubric(rubric?.id);

  const criteria: RubricCriteriaSelectGroupOption[] = useMemo(() => {
    // Only show criteria that have annotation checks
    let criteriaWithAnnotationChecks: RubricCriteria[] = [];

    if (rubricCriteria && rubricChecks) {
      const annotationChecks = rubricChecks
        .filter(
          (check: RubricCheck) =>
            check.is_annotation && (check.annotation_target === "file" || check.annotation_target === null)
        )
        .map((check: RubricCheck) => check.rubric_criteria_id);
      // Using the effective rubric (either manually selected or default)
      criteriaWithAnnotationChecks = rubricCriteria
        .filter((criteria: RubricCriteria) => annotationChecks.includes(criteria.id))
        .sort((a, b) => a.ordinal - b.ordinal);
    }

    const criteriaOptions: RubricCriteriaSelectGroupOption[] =
      (criteriaWithAnnotationChecks?.map((criteria) => {
        return {
          label: criteria.name,
          value: criteria.id.toString(),
          criteria: criteria as RubricCriteria,
          options: rubricChecks
            ?.filter(
              (check) =>
                check.is_annotation &&
                (check.annotation_target === "file" || check.annotation_target === null) &&
                check.rubric_criteria_id === criteria.id
            )
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((check) => {
              // Count existing annotations for this specific check
              const existingAnnotationsForCheck = existingComments.filter(
                (comment) => comment.rubric_check_id === check.id
              ).length;

              // Check if this option should be disabled due to max_annotations
              const isDisabled = check.max_annotations ? existingAnnotationsForCheck >= check.max_annotations : false;

              const option: RubricCheckSelectOption = {
                label: check.name,
                value: check.id.toString(),
                check,
                criteria: criteria as RubricCriteria,
                options: [],
                isDisabled
              };
              if (isRubricCheckDataWithOptions(check.data)) {
                option.options = check.data.options.map((subOption: RubricCheckSubOption, index: number) => ({
                  label: (criteria.is_additive ? "+" : "-") + subOption.points + " " + subOption.label,
                  comment: subOption.label,
                  index: index.toString(),
                  value: index.toString(),
                  points: subOption.points,
                  check: option,
                  isDisabled
                }));
              }
              return option;
            })
        };
      }) as RubricCriteriaSelectGroupOption[]) || [];

    criteriaOptions.push({
      label: "Leave a comment",
      value: "comment",
      options: [
        {
          label: "Leave a comment",
          value: "comment"
        }
      ]
    });

    return criteriaOptions;
  }, [existingComments, rubricCriteria, rubricChecks]);

  useEffect(() => {
    if (!visible) {
      return; // Exit early if not visible
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        close();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    // Defer adding the listeners
    const timerId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timerId);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [visible, close]);

  useEffect(() => {
    setSelectedCheckOption(null);
    setSelectedSubOption(null);
  }, [lineNumber]);
  useEffect(() => {
    // When the selected check changes, clear any previously selected sub-option
    setSelectedSubOption(null);
  }, [selectedCheckOption]);
  useEffect(() => {
    if (messageInputRef.current) {
      messageInputRef.current.focus();
    }
  }, [selectedCheckOption]);
  useEffect(() => {
    if (selectRef.current && !selectedCheckOption) {
      selectRef.current.focus();
    }
  }, [selectedCheckOption, lineNumber]);
  useEffect(() => {
    setCurrentMode(mode);
  }, [mode]);
  useEffect(() => {
    if (!visible) {
      // Reset transient popup state any time it is closed
      setCurrentMode(mode);
      setSelectedCheckOption(null);
      setSelectedSubOption(null);
      setSelectOpen(true);
    }
  }, [visible, mode]);
  if (!visible) {
    return null;
  }
  const numChecks = criteria.reduce((acc, curr) => acc + curr.options.length, 0);
  if (currentMode === "marking" && numChecks > 1) {
    return (
      <RubricMarkingMenu
        top={top}
        left={left}
        criteria={criteria}
        setSelectedSubOption={setSelectedSubOption}
        setSelectedCheckOption={setSelectedCheckOption}
        setCurrentMode={setCurrentMode}
      />
    );
  }
  //Adjust top so that it is less likely to end up off of the screen
  if (top + 250 > window.innerHeight && window.innerHeight > 250) {
    top = top - 250;
  }

  const components: SelectComponentsConfig<RubricCheckSelectOption, false, RubricCriteriaSelectGroupOption> = {
    GroupHeading: (props) => {
      return (
        <chakraComponents.GroupHeading {...props}>
          {props.data.criteria ? (
            <>
              Criteria: {props.data.label}
              {props.data.criteria.total_points ? ` (${props.data.criteria.total_points} points total)` : ""}
            </>
          ) : (
            <>
              <Separator />
            </>
          )}
        </chakraComponents.GroupHeading>
      );
    },
    SingleValue: (props) => {
      const points =
        props.data.criteria &&
        props.data.check?.points &&
        "(" + (props.data.criteria.is_additive ? "+" : "-" + props.data.check?.points?.toString()) + ")";
      return (
        <chakraComponents.SingleValue {...props}>
          {props.data.criteria && props.data.criteria.name + " > "} {props.data.label}{" "}
          {isRubricCheckDataWithOptions(props.data.check?.data)
            ? `(Select an option)`
            : points
              ? `${points} points`
              : ""}
        </chakraComponents.SingleValue>
      );
    },
    Option: (props) => {
      const points =
        props.data.criteria && props.data.check?.points
          ? "(" + ((props.data.criteria.is_additive ? "+" : "-") + props.data.check?.points?.toString()) + ")"
          : "";
      return (
        <chakraComponents.Option {...props}>
          {props.data.label} {points}
        </chakraComponents.Option>
      );
    }
  };

  return (
    <Box
      zIndex={1000}
      top={top}
      left={left}
      position="fixed"
      bg="bg.subtle"
      w="md"
      p={3}
      border="1px solid"
      borderColor="border.emphasized"
      borderRadius="md"
      boxShadow="lg"
      ref={popupRef}
    >
      <VStack gap={2} align="stretch">
        <Text fontSize="md" fontWeight="semibold" color="fg.default" textAlign="center">
          Annotate line {lineNumber} with a check:
        </Text>

        <HStack>
          <Select
            aria-label="Select a rubric check or leave a comment"
            ref={selectRef}
            options={criteria}
            menuIsOpen={selectOpen}
            onMenuOpen={() => {
              setSelectOpen(true);
            }}
            onMenuClose={() => {
              setSelectOpen(false);
            }}
            escapeClearsValue={true}
            components={components}
            value={selectedCheckOption}
            onChange={(e: RubricCheckSelectOption | null) => {
              if (e) {
                setSelectedCheckOption(e);
              }
            }}
            placeholder="Select a rubric check or leave a comment..."
            size="sm"
          />
          {selectedCheckOption && selectedCheckOption.check && (
            <StudentVisibilityIndicator
              check={selectedCheckOption.check}
              isApplied={true}
              isReleased={review?.released ?? true}
            />
          )}
        </HStack>
        {selectedCheckOption && (
          <>
            {isRubricCheckDataWithOptions(selectedCheckOption.check?.data) && (
              <Select
                options={selectedCheckOption.check.data.options.map(
                  (option: RubricCheckSubOption, index: number) =>
                    ({
                      label: option.label,
                      comment: option.label,
                      value: index.toString(),
                      index: index.toString(),
                      points: option.points,
                      check: selectedCheckOption
                    }) as RubricCheckSubOptions
                )}
                value={selectedSubOption}
                onChange={(e: RubricCheckSubOptions | null) => {
                  setSelectedSubOption(e);
                }}
                placeholder="Select an option for this check..."
                size="sm"
              />
            )}
            {!selectedSubOption && selectedCheckOption.check && selectedCheckOption.check.points ? (
              <Text fontSize="sm" color="fg.muted" mt={1} textAlign="center">
                {formatPoints({
                  check: selectedCheckOption.check,
                  criteria: selectedCheckOption.criteria,
                  points: selectedCheckOption.check.points
                })}
              </Text>
            ) : (
              <></>
            )}
            {selectedSubOption && selectedCheckOption.check ? (
              <Text fontSize="sm" color="fg.muted" mt={1} textAlign="center">
                {formatPoints({
                  check: selectedCheckOption.check,
                  criteria: selectedCheckOption.criteria,
                  points: selectedSubOption.points
                })}
              </Text>
            ) : (
              <></>
            )}
            <MessageInput
              textAreaRef={messageInputRef}
              enableGiphyPicker={true}
              sendButtonText={selectedCheckOption.check ? "Add Check" : "Add Comment"}
              placeholder={
                !selectedCheckOption.check
                  ? "Add a comment about this line and press enter to submit..."
                  : selectedCheckOption.check.is_comment_required
                    ? "Add a comment about this check and press enter to submit..."
                    : "Optionally add a comment, or just press enter to submit..."
              }
              allowEmptyMessage={selectedCheckOption.check && !selectedCheckOption.check.is_comment_required}
              defaultSingleLine={true}
              sendMessage={async (message, profile_id) => {
                let points = selectedCheckOption.check?.points;
                if (selectedSubOption !== null) {
                  points = selectedSubOption.points;
                }
                let comment = message || "";
                if (selectedSubOption) {
                  comment = selectedSubOption.comment + (comment ? "\n" + comment : "");
                }
                const submissionReviewId = review?.id;
                if (!submissionReviewId && selectedCheckOption.check?.id) {
                  toaster.error({
                    title: "Error saving comment",
                    description: "Submission review ID is missing, cannot save rubric annotation."
                  });
                  return;
                }
                const values = {
                  comment,
                  line: lineNumber,
                  rubric_check_id: selectedCheckOption.check?.id ?? null,
                  class_id: file.class_id,
                  submission_file_id: file.id,
                  submission_id: submission.id,
                  author: profile_id,
                  released: review ? review.released : true,
                  points: points ?? null,
                  submission_review_id: submissionReviewId ?? null,
                  eventually_visible: selectedCheckOption.check
                    ? selectedCheckOption.check.student_visibility !== "never"
                    : true,
                  regrade_request_id: null
                };
                try {
                  await submissionController.submission_file_comments.create(values);
                  setCurrentMode(mode);
                  close();
                } catch (e) {
                  toaster.error({
                    title: "Error saving annotation",
                    description: e instanceof Error ? e.message : "Unknown error"
                  });
                }
              }}
            />
          </>
        )}
      </VStack>
    </Box>
  );
}

/**
 * Renders all comments and rubric annotations for a specific line of code, along with the reply form if allowed.
 *
 * Displays line-specific comments and rubric-based annotations, filtering visibility based on user role and submission release status. Disables the reply form and "Add Comment" button if any comment on the line has an active regrade request.
 *
 * @param lineNumber - The line number for which to display comments and annotations.
 */
function CodeLineComments({ lineNumber }: { lineNumber: number }) {
  const {
    submission,
    showCommentsFeature,
    comments: allCommentsForFile,
    file,
    expanded,
    submissionReviewId
  } = useCodeLineCommentContext();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const isReplyEnabled = isGraderOrInstructor || submission.released !== null;
  const hasARegradeRequest = allCommentsForFile.some((comment) => comment.regrade_request_id !== null);
  const [showReply, setShowReply] = useState(isReplyEnabled);

  const commentsToDisplay = useMemo(() => {
    const ret = allCommentsForFile.filter((comment) => {
      if (comment.line !== lineNumber) return false;
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
  }, [allCommentsForFile, lineNumber, isGraderOrInstructor, submission.released]);

  if (!submission || !file || !showCommentsFeature || commentsToDisplay.length === 0) {
    return null;
  }
  if (!expanded.includes(lineNumber)) {
    return <></>;
  }

  return (
    <Box
      width="100%"
      whiteSpace="normal"
      position="relative"
      m={0}
      borderTop="1px solid"
      borderBottom="1px solid"
      borderColor="border.emphasized"
    >
      <Box position="absolute" left={0} w="40px" h="100%" borderRight="1px solid #ccc"></Box>
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

function LineNumber({ lineNumber }: { lineNumber: number }) {
  const { comments, open } = useCodeLineCommentContext();
  const hasComments = comments && comments.find((comment) => comment.line === lineNumber);
  if (hasComments) {
    return (
      <Box className="line-number" position="relative">
        {lineNumber}
        <Badge
          onClick={() => {
            open(lineNumber);
          }}
          variant="solid"
          colorPalette="blue"
          position="absolute"
          left={-5}
          top={0}
        >
          <Icon as={FaRegComment} />
        </Badge>
      </Box>
    );
  }
  return <div className="line-number">{lineNumber}</div>;
}

/**
 * @param {Array<ElementContent>} children
 * @param {number} line
 * @returns {Element}
 */
function createLine(
  children: ElementContent[],
  line: number,
  setLineActionPopup: Dispatch<SetStateAction<LineActionPopupDynamicProps>>
): Element {
  let mouseDownTime: number | null = null;
  let hasMoved = false;
  let popupShown = false;

  return {
    type: "element",
    tagName: "div",
    properties: {
      className: "source-code-line-container"
    } as Properties,
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {
          className: "source-code-line",
          id: `L${line}`,
          onClick: (ev: MouseEvent) => {
            ev.stopPropagation();
          },
          onMouseDown: (ev: MouseEvent) => {
            if (ev.button !== 0) {
              return;
            }
            ev.preventDefault();
            ev.stopPropagation();
            mouseDownTime = Date.now();
            hasMoved = false;
            popupShown = false;

            const checkShowPopup = () => {
              if (!popupShown && mouseDownTime !== null) {
                const timeHeld = Date.now() - mouseDownTime;
                if (timeHeld >= 300 || hasMoved) {
                  popupShown = true;
                  setLineActionPopup((prev) => {
                    if (line !== prev.lineNumber) {
                      prev.onClose?.();
                    }
                    return {
                      ...prev,
                      lineNumber: line,
                      top: ev.clientY,
                      left: ev.clientX,
                      visible: true,
                      mode: "marking",
                      close: () => {
                        setLineActionPopup((prevClose) => ({
                          ...prevClose,
                          visible: false,
                          onClose: prevClose.lineNumber === line && prevClose.visible ? undefined : prevClose.onClose
                        }));
                      },
                      onClose: undefined
                    };
                  });
                }
              }
            };

            // Check immediately for movement
            const handleMouseMove = () => {
              if (!hasMoved && mouseDownTime !== null) {
                hasMoved = true;
                checkShowPopup();
              }
            };

            // Set up movement listener
            document.addEventListener("mousemove", handleMouseMove);

            // Set up timer for 300ms check
            const timer = setTimeout(checkShowPopup, 300);

            // Clean up on mouse up
            const handleMouseUp = () => {
              mouseDownTime = null;
              document.removeEventListener("mousemove", handleMouseMove);
              clearTimeout(timer);
              document.removeEventListener("mouseup", handleMouseUp);
            };

            document.addEventListener("mouseup", handleMouseUp);
          },
          onContextMenu: (ev: MouseEvent) => {
            ev.preventDefault();
            ev.stopPropagation();
            const target = ev.currentTarget as HTMLElement;
            target.classList.add("selected");
            const closeAndCleanup = () => {
              target.classList.remove("selected");
              setLineActionPopup((prevClose) => ({
                ...prevClose,
                visible: false,
                onClose: undefined
              }));
            };
            setLineActionPopup((prev) => {
              if (line !== prev.lineNumber) {
                prev.onClose?.();
              }
              return {
                ...prev,
                lineNumber: line,
                top: ev.clientY,
                left: ev.clientX,
                visible: true,
                mode: "select",
                close: closeAndCleanup,
                onClose: () => {
                  target.classList.remove("selected");
                }
              };
            });
          }
        } as unknown as Properties,
        children: [
          {
            type: "element",
            tagName: "LineNumber",
            properties: { lineNumber: line } as Properties,
            children: []
          },
          {
            type: "element",
            tagName: "div",
            properties: {
              className: "source-code-line-content"
            } as Properties,
            children: children
          }
        ]
      },
      {
        type: "element",
        tagName: "CodeLineComments",
        properties: { lineNumber: line } as Properties,
        children: []
      }
    ]
  };
}
