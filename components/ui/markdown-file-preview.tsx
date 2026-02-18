"use client";

import {
  useGraderPseudonymousMode,
  useReviewAssignmentRubricParts,
  useRubricChecksByRubric,
  useRubricCriteriaByRubric,
  useRubricWithParts
} from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useSubmission, useSubmissionController, useSubmissionFileComments } from "@/hooks/useSubmission";
import { useActiveReviewAssignmentId, useActiveSubmissionReview } from "@/hooks/useSubmissionReview";
import { RubricCheck, RubricCriteria, SubmissionFile, SubmissionFileComment } from "@/utils/supabase/DatabaseTypes";
import type { SubmissionWithGraderResultsAndFiles } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import rehypeSourcePositions from "@/lib/rehype-source-positions";
import { Box, Badge, Button, Flex, Heading, HStack, Icon, Separator, Spinner, Text, VStack } from "@chakra-ui/react";
import { chakraComponents, Select, SelectComponentsConfig, SelectInstance } from "chakra-react-select";
import type { Element } from "hast";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkGemoji from "remark-gemoji";
import { FaCode, FaComments, FaEye, FaRegComment } from "react-icons/fa";
import CodeFile, {
  CodeLineComment,
  isRubricCheckDataWithOptions,
  LineCheckAnnotation,
  RubricCheckSelectOption,
  RubricCheckSubOptions,
  RubricCriteriaSelectGroupOption
} from "./code-file";
import LineCommentForm from "./line-comments-form";
import MessageInput from "./message-input";
import { StudentVisibilityIndicator } from "./rubric-sidebar";
import { Tooltip } from "./tooltip";
import { toaster } from "./toaster";

// Use line 0 as convention for file-level comments on markdown files
const MARKDOWN_FILE_COMMENT_LINE = 0;

// Types for file resolution
type ResolvedImageMap = Record<string, string>;

// Line action popup state
type LineActionPopupProps = {
  lineNumber: number;
  top: number;
  left: number;
  visible: boolean;
  onClose?: () => void;
  close: () => void;
};

// Context for markdown line comments (similar to CodeLineCommentContext)
type MarkdownLineCommentContextType = {
  submission: SubmissionWithGraderResultsAndFiles;
  comments: SubmissionFileComment[];
  file: SubmissionFile;
  expanded: number[];
  close: (line: number) => void;
  open: (line: number) => void;
  showCommentsFeature: boolean;
  submissionReviewId?: number;
  setLineActionPopup: React.Dispatch<React.SetStateAction<LineActionPopupProps>>;
};

const MarkdownLineCommentContext = createContext<MarkdownLineCommentContextType | undefined>(undefined);

function useMarkdownLineCommentContext() {
  const context = useContext(MarkdownLineCommentContext);
  if (!context) {
    throw new Error("useMarkdownLineCommentContext must be used within MarkdownLineCommentContext");
  }
  return context;
}

// Mermaid diagram component - renders code blocks with language "mermaid"
function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const mermaid = (await import("mermaid")).default;
        // securityLevel: "strict" enables Mermaid's built-in DOMPurify sanitization
        // to prevent XSS from student-authored diagram input
        mermaid.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "strict"
        });
        const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`;
        const { svg: renderedSvg } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(renderedSvg);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render mermaid diagram");
        }
      }
    }
    render();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <Box borderWidth="1px" borderColor="border.error" borderRadius="md" p={3} my={2}>
        <Text color="fg.error" fontSize="sm">
          Mermaid diagram error: {error}
        </Text>
        <Box as="pre" fontSize="xs" mt={2} p={2} bg="bg.subtle" borderRadius="sm" overflow="auto">
          <code>{code}</code>
        </Box>
      </Box>
    );
  }

  if (!svg) {
    return (
      <Flex justify="center" align="center" py={4}>
        <Spinner size="sm" />
        <Text ml={2} fontSize="sm" color="fg.muted">
          Rendering diagram...
        </Text>
      </Flex>
    );
  }

  return (
    <Box
      ref={containerRef}
      my={2}
      display="flex"
      justifyContent="center"
      // SVG is sanitized by mermaid.initialize({ securityLevel: "strict" }) above
      dangerouslySetInnerHTML={{ __html: svg }}
      css={{
        "& svg": {
          maxWidth: "100%",
          height: "auto"
        }
      }}
    />
  );
}

// Determine the MIME type from a file extension
function getMimeFromExtension(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    tiff: "image/tiff",
    tif: "image/tiff"
  };
  return mimeMap[ext] || "application/octet-stream";
}

// Check if a file is an image
function isImageFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico", "tiff", "tif"].includes(ext);
}

// Check if a file is a markdown file
export function isMarkdownFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ["md", "markdown", "mdown", "mkdn", "mkd"].includes(ext);
}

// Resolve a relative path from the current file's directory
function resolveRelativePath(currentFilePath: string, relativePath: string): string {
  // Absolute paths (root-relative): e.g. /images/photo.png -> images/photo.png
  if (relativePath.startsWith("/")) {
    return relativePath.replace(/^\/+/, "");
  }

  // Get the directory of the current file
  const parts = currentFilePath.split("/");
  parts.pop(); // Remove the file name
  const dir = parts.join("/");

  // Handle relative path (./ and ../ cases)
  const segments = (dir ? dir + "/" + relativePath : relativePath).split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      resolved.pop();
    } else if (seg !== "." && seg !== "") {
      resolved.push(seg);
    }
  }
  return resolved.join("/");
}

/** Max size (10MB) for inlining images as data URIs. Larger files return "" to avoid OOM. */
const MAX_INLINE_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Fetches binary file content from Supabase Storage and returns a data URI.
 * Uses FileReader.readAsDataURL for O(n) base64 encoding (avoids quadratic reduce on large files).
 * Returns "" if the file exceeds MAX_INLINE_IMAGE_SIZE to avoid OOM; callers should render a
 * placeholder for oversized or failed images.
 */
async function fetchBinaryFileAsDataUri(storageKey: string, mimeType: string): Promise<string> {
  const client = createClient();
  const { data, error } = await client.storage.from("submission-files").download(storageKey);
  if (error || !data) {
    return "";
  }
  const size = data.size ?? 0;
  if (size > MAX_INLINE_IMAGE_SIZE) {
    return "";
  }
  const blob = new Blob([data], { type: mimeType });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(typeof result === "string" ? result : `data:${mimeType};base64,`);
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}

/**
 * Displays file-level comments on a markdown file preview.
 * Uses line=0 as convention for file-level comments.
 */
function MarkdownFileComments({ file }: { file: SubmissionFile }) {
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const allComments = useSubmissionFileComments({ file_id: file.id });

  const commentsToDisplay = useMemo(() => {
    const ret = allComments.filter((comment: SubmissionFileComment) => {
      if (comment.line !== MARKDOWN_FILE_COMMENT_LINE) return false;
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
  }, [allComments, isGraderOrInstructor, submission.released]);

  return (
    <Box>
      {commentsToDisplay.map((comment) =>
        comment.rubric_check_id ? (
          <LineCheckAnnotation key={comment.id} comment_id={comment.id} />
        ) : (
          <CodeLineComment key={comment.id} comment_id={comment.id} />
        )
      )}
    </Box>
  );
}

/**
 * Popup for annotating a line in the markdown preview on right-click.
 * Duplicated logic from code-file.tsx LineActionPopup for markdown context.
 */
function MarkdownLineActionPopup({
  lineNumber,
  top,
  left,
  visible,
  close,
  file
}: LineActionPopupProps & { file: SubmissionFile }) {
  const submissionController = useSubmissionController();
  const submission = useSubmission();
  const review = useActiveSubmissionReview();
  const rubric = useRubricWithParts(review?.rubric_id);
  const activeReviewAssignmentId = useActiveReviewAssignmentId();
  const assignedRubricParts = useReviewAssignmentRubricParts(activeReviewAssignmentId);
  const assignedPartIds = useMemo(
    () => new Set(assignedRubricParts.map((part) => part.rubric_part_id)),
    [assignedRubricParts]
  );
  const [selectOpen, setSelectOpen] = useState(true);
  const { private_profile_id, public_profile_id } = useClassProfiles();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const graderPseudonymousMode = useGraderPseudonymousMode();
  const authorProfileId = isGraderOrInstructor && graderPseudonymousMode ? public_profile_id : private_profile_id;

  const [selectedCheckOption, setSelectedCheckOption] = useState<RubricCheckSelectOption | null>(null);
  const [selectedSubOption, setSelectedSubOption] = useState<RubricCheckSubOptions | null>(null);
  const selectRef = useRef<SelectInstance<RubricCheckSelectOption, false, RubricCriteriaSelectGroupOption>>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const existingComments = useSubmissionFileComments({ file_id: file.id });
  const rubricCriteria = useRubricCriteriaByRubric(rubric?.id);
  const rubricChecks = useRubricChecksByRubric(rubric?.id);

  const criteria: RubricCriteriaSelectGroupOption[] = useMemo(() => {
    let criteriaWithAnnotationChecks: RubricCriteria[] = [];
    if (rubricCriteria && rubricChecks) {
      const annotationChecks = rubricChecks
        .filter(
          (check: RubricCheck) =>
            check.is_annotation && (check.annotation_target === "file" || check.annotation_target === null)
        )
        .map((check: RubricCheck) => check.rubric_criteria_id);
      criteriaWithAnnotationChecks = rubricCriteria.filter((criteria: RubricCriteria) =>
        annotationChecks.includes(criteria.id)
      );
    }
    const sortedCriteria = [...criteriaWithAnnotationChecks].sort((a, b) => {
      const aAssigned = assignedPartIds.has(a.rubric_part_id ?? -1);
      const bAssigned = assignedPartIds.has(b.rubric_part_id ?? -1);
      if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
      return a.ordinal - b.ordinal;
    });
    const criteriaOptions: RubricCriteriaSelectGroupOption[] =
      (sortedCriteria?.map((criteria) => ({
        label: criteria.name,
        value: criteria.id.toString(),
        criteria: criteria as RubricCriteria,
        options:
          rubricChecks
            ?.filter(
              (check) =>
                check.is_annotation &&
                (check.annotation_target === "file" || check.annotation_target === null) &&
                check.rubric_criteria_id === criteria.id
            )
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((check) => {
              const existingAnnotationsForCheck = existingComments.filter(
                (comment) => comment.rubric_check_id === check.id
              ).length;
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
                option.options = check.data.options.map(
                  (subOption: { label: string; points: number }, index: number) => ({
                    label: (criteria.is_additive ? "+" : "-") + subOption.points + " " + subOption.label,
                    comment: subOption.label,
                    index: index.toString(),
                    value: index.toString(),
                    points: subOption.points,
                    check: option,
                    isDisabled
                  })
                );
              }
              return option;
            }) ?? []
      })) as RubricCriteriaSelectGroupOption[]) ?? [];
    criteriaOptions.push({
      label: "Leave a comment",
      value: "comment",
      options: [{ label: "Leave a comment", value: "comment" }]
    });
    return criteriaOptions;
  }, [assignedPartIds, existingComments, rubricCriteria, rubricChecks]);

  useEffect(() => {
    if (!visible) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
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
  useEffect(() => setSelectedSubOption(null), [selectedCheckOption]);
  useEffect(() => {
    if (messageInputRef.current) messageInputRef.current.focus();
  }, [selectedCheckOption]);
  useEffect(() => {
    if (selectRef.current && !selectedCheckOption) selectRef.current.focus();
  }, [selectedCheckOption, lineNumber]);
  useEffect(() => {
    if (!visible) {
      setSelectedCheckOption(null);
      setSelectedSubOption(null);
      setSelectOpen(true);
    }
  }, [visible]);

  const filterOption = useCallback((option: { label: string; data: RubricCheckSelectOption }, rawInput: string) => {
    const search = rawInput.trim().toLowerCase();
    if (!search) return true;
    const optionLabel = option.label.toLowerCase();
    const criteriaLabel = option.data.criteria?.name?.toLowerCase() ?? "";
    return optionLabel.includes(search) || criteriaLabel.includes(search);
  }, []);

  if (!visible) return null;
  const adjustedTop = top + 250 > window.innerHeight && window.innerHeight > 250 ? top - 250 : top;

  const selectComponents: SelectComponentsConfig<RubricCheckSelectOption, false, RubricCriteriaSelectGroupOption> = {
    GroupHeading: (props) => (
      <chakraComponents.GroupHeading {...props}>
        {props.data.criteria ? <>Criteria: {props.data.label}</> : <Separator />}
      </chakraComponents.GroupHeading>
    ),
    Option: (props) => (
      <chakraComponents.Option {...props}>
        {props.data.label}{" "}
        {props.data.check?.points ? `(${props.data.criteria?.is_additive ? "+" : "-"}${props.data.check.points})` : ""}
      </chakraComponents.Option>
    )
  };

  return (
    <Box
      zIndex={1000}
      top={adjustedTop}
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
          {lineNumber === 0 ? "Annotate file" : `Annotate line ${lineNumber}`} with a check:
        </Text>
        <HStack>
          <Select
            aria-label="Select a rubric check or leave a comment"
            ref={selectRef}
            options={criteria}
            menuIsOpen={selectOpen}
            onMenuOpen={() => setSelectOpen(true)}
            onMenuClose={() => setSelectOpen(false)}
            escapeClearsValue={true}
            components={selectComponents}
            filterOption={filterOption}
            value={selectedCheckOption}
            onChange={(e: RubricCheckSelectOption | null) => e && setSelectedCheckOption(e)}
            placeholder="Select a rubric check or leave a comment..."
            size="sm"
          />
          {selectedCheckOption?.check && (
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
                options={(selectedCheckOption.check.data.options ?? []).map(
                  (option: { label: string; points: number }, index: number) =>
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
                onChange={(e: RubricCheckSubOptions | null) => setSelectedSubOption(e)}
                placeholder="Select an option for this check..."
                size="sm"
              />
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
              allowEmptyMessage={selectedCheckOption.check ? !selectedCheckOption.check.is_comment_required : true}
              defaultSingleLine={true}
              sendMessage={async (message) => {
                let points = selectedCheckOption.check?.points;
                if (selectedSubOption !== null) points = selectedSubOption.points;
                let comment = message || "";
                if (selectedSubOption) comment = selectedSubOption.comment + (comment ? "\n" + comment : "");
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
                  author: authorProfileId,
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
 * Renders comments for a specific line in the markdown preview.
 */
function MarkdownLineComments({ lineNumber }: { lineNumber: number }) {
  const {
    submission,
    showCommentsFeature,
    comments: allCommentsForFile,
    file,
    expanded,
    submissionReviewId
  } = useMarkdownLineCommentContext();
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

  if (!submission || !file || !showCommentsFeature || commentsToDisplay.length === 0) return null;
  if (!expanded.includes(lineNumber)) return null;

  return (
    <Box
      width="100%"
      whiteSpace="normal"
      position="relative"
      m={0}
      mt={2}
      borderTop="1px solid"
      borderBottom="1px solid"
      borderColor="border.emphasized"
    >
      <Box
        position="relative"
        maxW="xl"
        fontFamily="sans-serif"
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

/** Wrapper for block elements that adds right-click handler and inline comments. */
function createMarkdownBlockWrapper<P extends { node?: Element; children?: React.ReactNode } & Record<string, unknown>>(
  Inner: React.ComponentType<P>,
  baseProps?: Partial<P>
) {
  return function MarkdownBlockWrapper(props: P) {
    const { node, children, ...rest } = props;
    const {
      setLineActionPopup,
      comments: allComments,
      open,
      expanded,
      showCommentsFeature
    } = useMarkdownLineCommentContext();
    const lineStart = node?.properties
      ? Number((node.properties as Record<string, unknown>)["data-source-line-start"])
      : null;
    const lineEnd = node?.properties
      ? Number((node.properties as Record<string, unknown>)["data-source-line-end"])
      : null;
    const effectiveLine = lineStart ?? lineEnd ?? 0;
    const hasComments =
      showCommentsFeature &&
      effectiveLine > 0 &&
      allComments.some((c) => c.line >= effectiveLine && c.line <= (lineEnd ?? lineStart ?? effectiveLine));
    const isExpanded = expanded.includes(effectiveLine);

    const handleContextMenu = (ev: React.MouseEvent) => {
      if (!showCommentsFeature || effectiveLine <= 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const target = ev.currentTarget as HTMLElement;
      target.classList.add("markdown-line-selected");
      const closeAndCleanup = () => {
        target.classList.remove("markdown-line-selected");
        setLineActionPopup((prev) => ({ ...prev, visible: false, onClose: undefined }));
      };
      setLineActionPopup((prev) => ({
        ...prev,
        lineNumber: effectiveLine,
        top: ev.clientY,
        left: ev.clientX,
        visible: true,
        close: closeAndCleanup,
        onClose: () => target.classList.remove("markdown-line-selected")
      }));
    };

    const innerContent = (
      <Inner {...(baseProps as P)} {...(rest as P)} node={node}>
        {children}
      </Inner>
    );

    if (showCommentsFeature && effectiveLine > 0) {
      return (
        <Box
          onContextMenu={handleContextMenu}
          className="markdown-block-with-comments"
          css={{
            "&:hover": { bg: "yellow.subtle" },
            "&.markdown-line-selected": { bg: "yellow.subtle" }
          }}
        >
          {innerContent}
          {hasComments && !isExpanded && (
            <HStack mt={1} gap={1}>
              <Tooltip content="Click to expand comments">
                <Badge
                  cursor="pointer"
                  variant="solid"
                  colorPalette="blue"
                  onClick={(e) => {
                    e.stopPropagation();
                    open(effectiveLine);
                  }}
                >
                  <Icon as={FaRegComment} mr={1} />
                  Comments
                </Badge>
              </Tooltip>
            </HStack>
          )}
          {isExpanded && effectiveLine > 0 && <MarkdownLineComments lineNumber={effectiveLine} />}
        </Box>
      );
    }
    return <>{innerContent}</>;
  };
}

interface MarkdownFilePreviewProps {
  file: SubmissionFile;
  allFiles: SubmissionFile[];
  onNavigateToFile?: (fileId: number) => void;
}

export default function MarkdownFilePreview({ file, allFiles, onNavigateToFile }: MarkdownFilePreviewProps) {
  const [resolvedImages, setResolvedImages] = useState<ResolvedImageMap>({});
  const [loading, setLoading] = useState(true);
  const content = file.contents || "";
  const submission = useSubmission();
  const submissionReview = useActiveSubmissionReview();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const showCommentsFeature = true;

  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const [lineActionPopupProps, setLineActionPopupProps] = useState<LineActionPopupProps>(() => ({
    lineNumber: 0,
    top: 0,
    left: 0,
    visible: false,
    close: () => {}
  }));
  const [expanded, setExpanded] = useState<number[]>([]);

  const onCommentsEnter = useCallback(
    (newlyEnteredComments: SubmissionFileComment[]) => {
      if (showCommentsFeature) {
        setExpanded((currentExpanded) => {
          const linesFromNewComments = newlyEnteredComments.map((c) => c.line);
          const linesToAdd = linesFromNewComments.filter((line) => !currentExpanded.includes(line));
          return linesToAdd.length > 0 ? [...currentExpanded, ...linesToAdd] : currentExpanded;
        });
      }
    },
    [showCommentsFeature]
  );

  const allComments = useSubmissionFileComments({ file_id: file.id, onEnter: onCommentsEnter });
  const comments = allComments;

  // Build a lookup map of all files by their name/path
  const fileMap = useMemo(() => {
    const map = new Map<string, SubmissionFile>();
    for (const f of allFiles) {
      map.set(f.name, f);
    }
    return map;
  }, [allFiles]);

  // Find all image references in the markdown and pre-resolve them
  useEffect(() => {
    let cancelled = false;

    async function resolveImages() {
      // Match markdown image references: ![alt](path) and HTML img src="path"
      const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)|<img[^>]+src=["']([^"']+)["']/g;
      const matches = content.matchAll(imageRegex);
      const imagePaths = new Set<string>();

      for (const match of matches) {
        const imgPath = match[2] || match[3];
        if (
          imgPath &&
          !imgPath.startsWith("http://") &&
          !imgPath.startsWith("https://") &&
          !imgPath.startsWith("data:")
        ) {
          imagePaths.add(imgPath);
        }
      }

      const resolved: ResolvedImageMap = {};

      for (const imgPath of imagePaths) {
        const resolvedPath = resolveRelativePath(file.name, imgPath);
        const matchingFile = fileMap.get(resolvedPath) || fileMap.get(imgPath);

        if (matchingFile) {
          if (matchingFile.is_binary && matchingFile.storage_key) {
            // Binary file - fetch from Supabase Storage. Returns "" if oversized (exceeds MAX_INLINE_IMAGE_SIZE)
            // or on error; we skip adding to resolved so the img component renders its placeholder.
            const mime = matchingFile.mime_type || getMimeFromExtension(matchingFile.name);
            const dataUri = await fetchBinaryFileAsDataUri(matchingFile.storage_key, mime);
            if (dataUri) {
              resolved[imgPath] = dataUri;
            }
          } else if (!matchingFile.is_binary && matchingFile.contents && isImageFile(matchingFile.name)) {
            // SVG or text-based image stored inline
            const mime = getMimeFromExtension(matchingFile.name);
            if (mime === "image/svg+xml") {
              resolved[imgPath] = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(matchingFile.contents)}`;
            }
          }
        }
      }

      if (!cancelled) {
        setResolvedImages(resolved);
        setLoading(false);
      }
    }

    resolveImages();
    return () => {
      cancelled = true;
    };
  }, [content, file.name, fileMap]);

  // Custom components for ReactMarkdown (block elements wrapped for line comments)
  const components = useMemo(
    () =>
      ({
        // Block elements with line comment support
        p: createMarkdownBlockWrapper(({ children, ...p }) => (
          <Box as="p" {...p}>
            {children}
          </Box>
        )),
        h1: createMarkdownBlockWrapper(({ children, ...p }) => (
          <Heading as="h1" size="2xl" mt={6} mb={3} {...p}>
            {children}
          </Heading>
        )),
        h2: createMarkdownBlockWrapper(({ children, ...p }) => (
          <Heading
            as="h2"
            size="xl"
            mt={5}
            mb={2}
            borderBottomWidth="1px"
            borderColor="border.emphasized"
            pb={1}
            {...p}
          >
            {children}
          </Heading>
        )),
        h3: createMarkdownBlockWrapper(({ children, ...p }) => (
          <Heading as="h3" size="lg" mt={4} mb={2} {...p}>
            {children}
          </Heading>
        )),
        h4: createMarkdownBlockWrapper(({ children, ...p }) => (
          <Heading as="h4" size="md" mt={3} mb={1} {...p}>
            {children}
          </Heading>
        )),
        h5: createMarkdownBlockWrapper(({ children, ...p }) => (
          <Heading as="h5" size="sm" mt={2} mb={1} {...p}>
            {children}
          </Heading>
        )),
        h6: createMarkdownBlockWrapper(({ children, ...p }) => (
          <Heading as="h6" size="xs" mt={2} mb={1} {...p}>
            {children}
          </Heading>
        )),
        blockquote: createMarkdownBlockWrapper(({ children, ...p }) => (
          <Box
            as="blockquote"
            borderLeftWidth="4px"
            borderLeftColor="blue.300"
            pl={4}
            py={1}
            my={2}
            color="fg.muted"
            {...p}
          >
            {children}
          </Box>
        )),
        ul: createMarkdownBlockWrapper(({ children, ...p }) => (
          <Box as="ul" {...p}>
            {children}
          </Box>
        )),
        ol: createMarkdownBlockWrapper(({ children, ...p }) => (
          <Box as="ol" {...p}>
            {children}
          </Box>
        )),

        // Custom image renderer that resolves paths
        img: ({ src, alt, ...props }) => {
          if (src && resolvedImages[src]) {
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={resolvedImages[src]} alt={alt || ""} style={{ maxWidth: "100%", height: "auto" }} {...props} />
            );
          }
          // For external images, render normally
          if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={alt || ""} style={{ maxWidth: "100%", height: "auto" }} {...props} />
            );
          }
          // Unresolved local image - show placeholder
          return (
            <Box
              display="inline-block"
              borderWidth="1px"
              borderColor="border.emphasized"
              borderRadius="md"
              p={2}
              my={1}
            >
              <Text fontSize="sm" color="fg.muted">
                [Image: {alt || src || "unknown"}]
              </Text>
            </Box>
          );
        },

        // Custom link renderer that handles internal file navigation
        a: ({ href, children, ...props }) => {
          if (href && !href.startsWith("http://") && !href.startsWith("https://") && !href.startsWith("#")) {
            // Relative link - check if it points to another submission file
            const resolvedPath = resolveRelativePath(file.name, href);
            const matchingFile = fileMap.get(resolvedPath) || fileMap.get(href);

            if (matchingFile && onNavigateToFile) {
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigateToFile(matchingFile.id);
                  }}
                  style={{ color: "var(--chakra-colors-blue-500)", textDecoration: "underline", cursor: "pointer" }}
                  {...props}
                >
                  {children}
                </a>
              );
            }
          }

          // External link or anchor - render normally
          return (
            <a href={href} target={href?.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" {...props}>
              {children}
            </a>
          );
        },

        // Custom code block renderer that handles mermaid (with line comment support)
        pre: createMarkdownBlockWrapper(({ children, ...props }) => {
          const childArray = React.Children.toArray(children);
          const mermaidChild = childArray.find(
            (child) =>
              React.isValidElement(child) &&
              (child.props as { className?: string }).className?.includes("language-mermaid")
          );
          if (mermaidChild && React.isValidElement(mermaidChild)) {
            const childProps = mermaidChild.props as { children?: React.ReactNode };
            const code =
              typeof childProps.children === "string"
                ? childProps.children
                : Array.isArray(childProps.children)
                  ? childProps.children.join("")
                  : "";
            if (code) {
              return <MermaidDiagram code={code.trim()} />;
            }
          }
          return <pre {...props}>{children}</pre>;
        }),

        // Custom table renderer for better styling (with line comment support)
        table: createMarkdownBlockWrapper(({ children, ...props }) => (
          <Box overflowX="auto" my={2}>
            <Box
              as="table"
              width="100%"
              borderWidth="1px"
              borderColor="border.emphasized"
              borderRadius="md"
              {...props}
              css={{
                borderCollapse: "collapse",
                "& th, & td": {
                  border: "1px solid var(--chakra-colors-border-emphasized)",
                  padding: "8px 12px",
                  textAlign: "left"
                },
                "& th": {
                  backgroundColor: "var(--chakra-colors-bg-subtle)",
                  fontWeight: "bold"
                },
                "& tr:nth-of-type(even)": {
                  backgroundColor: "var(--chakra-colors-bg-subtle)"
                }
              }}
            >
              {children}
            </Box>
          </Box>
        )),

        // Custom checkbox rendering for task lists
        input: ({ type, checked, ...props }) => {
          if (type === "checkbox") {
            return <input type="checkbox" checked={checked} readOnly style={{ marginRight: "6px" }} {...props} />;
          }
          return <input type={type} {...props} />;
        },

        // Horizontal rule
        hr: ({ ...props }) => <Box as="hr" my={4} borderColor="border.emphasized" {...props} />
      }) as Components,
    [resolvedImages, file.name, fileMap, onNavigateToFile]
  );

  const contextValue: MarkdownLineCommentContextType = useMemo(
    () => ({
      submission: submission as SubmissionWithGraderResultsAndFiles,
      comments: allComments,
      file,
      expanded,
      open: (line) => setExpanded((prev) => (prev.includes(line) ? prev : [...prev, line])),
      close: (line) => setExpanded((prev) => prev.filter((l) => l !== line)),
      showCommentsFeature,
      submissionReviewId: submissionReview?.id,
      setLineActionPopup: setLineActionPopupProps
    }),
    [submission, allComments, file, expanded, showCommentsFeature, submissionReview?.id]
  );

  if (loading) {
    return (
      <Box p={4}>
        <Flex align="center" gap={2}>
          <Spinner size="sm" />
          <Text color="fg.muted">Loading markdown preview...</Text>
        </Flex>
      </Box>
    );
  }

  return (
    <MarkdownLineCommentContext.Provider value={contextValue}>
      <Box border="1px solid" borderColor="border.emphasized" borderRadius="md" m={2} w="100%">
        <Flex
          w="100%"
          bg="bg.subtle"
          p={2}
          borderBottom="1px solid"
          borderColor="border.emphasized"
          alignItems="center"
          justifyContent="space-between"
        >
          <HStack>
            <Text fontSize="xs" color="text.subtle">
              {file.name}
            </Text>
            <HStack gap={0} role="group">
              <Button
                variant={viewMode === "preview" ? "solid" : "outline"}
                size="xs"
                colorPalette="green"
                borderRadius="md"
                borderRightRadius={0}
                onClick={() => setViewMode("preview")}
              >
                <HStack gap={1} fontSize="xs">
                  <Icon as={FaEye} />
                  <Text>Preview</Text>
                </HStack>
              </Button>
              <Button
                variant={viewMode === "source" ? "solid" : "outline"}
                size="xs"
                colorPalette="green"
                borderRadius="md"
                borderLeftRadius={0}
                onClick={() => setViewMode("source")}
              >
                <HStack gap={1} fontSize="xs">
                  <Icon as={FaCode} />
                  <Text>Source</Text>
                </HStack>
              </Button>
            </HStack>
            {comments.length > 0 && (
              <>
                <Text fontSize="xs" color="text.subtle">
                  {comments.length} {comments.length === 1 ? "comment" : "comments"}
                </Text>
                {showCommentsFeature && (
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
                      onClick={() =>
                        setExpanded((prev) =>
                          prev.length === 0
                            ? [...new Set(allComments.filter((c) => c.line > 0).map((c) => c.line))]
                            : []
                        )
                      }
                    >
                      <Icon as={FaComments} m={0} />
                    </Button>
                  </Tooltip>
                )}
              </>
            )}
          </HStack>
        </Flex>
        <MarkdownLineActionPopup {...lineActionPopupProps} file={file} />
        {viewMode === "preview" ? (
          <Box
            p={6}
            className="markdown-file-preview"
            css={markdownPreviewStyles}
            onClick={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              lineActionPopupProps.onClose?.();
              setLineActionPopupProps((prev) => ({ ...prev, visible: false, onClose: undefined }));
            }}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath, remarkGemoji]}
              rehypePlugins={[rehypeKatex, rehypeHighlight, rehypeSourcePositions]}
              components={components}
            >
              {content}
            </ReactMarkdown>
          </Box>
        ) : (
          <CodeFile file={file} embedded language="text.md" />
        )}
        <Box
          borderTop="1px solid"
          borderColor="border.emphasized"
          p={4}
          onContextMenu={
            isGraderOrInstructor
              ? (e) => {
                  e.preventDefault();
                  setLineActionPopupProps((prev) => ({
                    ...prev,
                    lineNumber: MARKDOWN_FILE_COMMENT_LINE,
                    top: e.clientY,
                    left: e.clientX,
                    visible: true,
                    close: () => setLineActionPopupProps((p) => ({ ...p, visible: false, onClose: undefined })),
                    onClose: undefined
                  }));
                }
              : undefined
          }
          css={isGraderOrInstructor ? { cursor: "context-menu", "&:hover": { bg: "bg.subtle" } } : undefined}
        >
          <MarkdownFileComments file={file} />
        </Box>
      </Box>
    </MarkdownLineCommentContext.Provider>
  );
}

// CSS styles for the markdown preview container
const markdownPreviewStyles = {
  "& p": {
    marginBottom: "1em",
    lineHeight: "1.7"
  },
  "& ul, & ol": {
    paddingLeft: "2em",
    marginBottom: "1em"
  },
  "& ul": {
    listStyleType: "disc"
  },
  "& ol": {
    listStyleType: "decimal"
  },
  "& li": {
    display: "list-item",
    marginBottom: "0.25em"
  },
  "& li > ul, & li > ol": {
    marginBottom: 0
  },
  "& pre": {
    backgroundColor: "var(--chakra-colors-bg-subtle)",
    padding: "1em",
    borderRadius: "0.375rem",
    overflow: "auto",
    marginBottom: "1em",
    border: "1px solid var(--chakra-colors-border-emphasized)"
  },
  "& code": {
    fontFamily: "monospace",
    fontSize: "0.9em"
  },
  "& :not(pre) > code": {
    backgroundColor: "var(--chakra-colors-bg-subtle)",
    padding: "0.2em 0.4em",
    borderRadius: "0.25rem",
    fontSize: "0.85em"
  },
  "& a": {
    color: "var(--chakra-colors-blue-500)",
    textDecoration: "underline"
  },
  "& a:hover": {
    color: "var(--chakra-colors-blue-600)"
  },
  "& img": {
    maxWidth: "100%",
    height: "auto",
    borderRadius: "0.375rem"
  },
  "& .contains-task-list": {
    listStyle: "none",
    paddingLeft: "0.5em"
  }
};
