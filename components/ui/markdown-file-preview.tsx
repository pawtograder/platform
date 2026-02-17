"use client";

import { Checkbox } from "@/components/ui/checkbox";
import {
  PopoverArrow,
  PopoverBody,
  PopoverCloseTrigger,
  PopoverContent,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger
} from "@/components/ui/popover";
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
import {
  RubricCheck,
  RubricChecksDataType,
  SubmissionFile,
  SubmissionFileComment
} from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Flex, Heading, HStack, Separator, Spinner, Text, VStack } from "@chakra-ui/react";
import { chakraComponents, Select, SelectComponentsConfig } from "chakra-react-select";
import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkGemoji from "remark-gemoji";
import {
  CodeLineComment,
  formatPoints,
  isRubricCheckDataWithOptions,
  LineCheckAnnotation,
  RubricCheckSelectOption,
  RubricCheckSubOptions,
  RubricCriteriaSelectGroupOption
} from "./code-file";
import LineCommentForm from "./line-comments-form";
import MessageInput from "./message-input";
import { toaster } from "./toaster";

// Use line 0 as convention for file-level comments on markdown files
const MARKDOWN_FILE_COMMENT_LINE = 0;

// Types for file resolution
type ResolvedImageMap = Record<string, string>;

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

// Fetch binary file content from Supabase Storage and return data URI.
// Uses FileReader.readAsDataURL for O(n) base64 encoding (avoids quadratic reduce on large files).
async function fetchBinaryFileAsDataUri(storageKey: string, mimeType: string): Promise<string> {
  const client = createClient();
  const { data, error } = await client.storage.from("submission-files").download(storageKey);
  if (error || !data) {
    console.error("Failed to fetch binary file from storage:", error);
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
  const submissionReview = useActiveSubmissionReview();
  const allComments = useSubmissionFileComments({ file_id: file.id });

  const commentsToDisplay = useMemo(() => {
    const ret = allComments.filter((comment: SubmissionFileComment) => {
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
      <LineCommentForm
        lineNumber={MARKDOWN_FILE_COMMENT_LINE}
        submission={submission}
        file={file}
        submissionReviewId={submissionReview?.id}
      />
    </Box>
  );
}

/**
 * Popover for adding rubric check annotations on a markdown file.
 * Modeled after ArtifactCheckPopover but uses submission_file_comments with line=0.
 */
function MarkdownAnnotationPopover({ file }: { file: SubmissionFile }) {
  const submission = useSubmission();
  const submissionReview = useActiveSubmissionReview();
  const rubric = useRubricWithParts(submissionReview?.rubric_id);
  const rubricCriteria = useRubricCriteriaByRubric(rubric?.id);
  const rubricChecks = useRubricChecksByRubric(rubric?.id);

  const activeReviewAssignmentId = useActiveReviewAssignmentId();
  const assignedRubricParts = useReviewAssignmentRubricParts(activeReviewAssignmentId);
  const assignedPartIds = useMemo(
    () => new Set(assignedRubricParts.map((part) => part.rubric_part_id)),
    [assignedRubricParts]
  );

  const [selectedCheckOption, setSelectedCheckOption] = useState<RubricCheckSelectOption | null>(null);
  const [selectedSubOption, setSelectedSubOption] = useState<RubricCheckSubOptions | null>(null);
  const submissionController = useSubmissionController();

  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const { private_profile_id, public_profile_id } = useClassProfiles();
  const graderPseudonymousMode = useGraderPseudonymousMode();
  const authorProfileId = isGraderOrInstructor && graderPseudonymousMode ? public_profile_id : private_profile_id;
  const [eventuallyVisible, setEventuallyVisible] = useState(true);
  const [isOpen, setIsOpen] = useState(false);

  const existingComments = useSubmissionFileComments({ file_id: file.id });

  useEffect(() => {
    if (isOpen && messageInputRef.current && selectedCheckOption) {
      messageInputRef.current.focus();
    }
  }, [isOpen, selectedCheckOption]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedCheckOption(null);
      setSelectedSubOption(null);
    }
  }, [isOpen]);

  // Filter criteria that have file annotation checks
  const criteriaOptions: RubricCriteriaSelectGroupOption[] = useMemo(() => {
    if (!rubricCriteria || !rubricChecks) return [];

    const annotationCheckCriteriaIds = rubricChecks
      .filter(
        (check: RubricCheck) =>
          check.is_annotation && (check.annotation_target === "file" || check.annotation_target === null)
      )
      .map((check: RubricCheck) => check.rubric_criteria_id);

    const criteriaWithAnnotationChecks = rubricCriteria
      .filter((criteria) => annotationCheckCriteriaIds.includes(criteria.id))
      .sort((a, b) => {
        const aAssigned = assignedPartIds.has(a.rubric_part_id ?? -1);
        const bAssigned = assignedPartIds.has(b.rubric_part_id ?? -1);
        if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
        return a.ordinal - b.ordinal;
      });

    return criteriaWithAnnotationChecks.map((criteria) => ({
      label: criteria.name,
      value: criteria.id.toString(),
      criteria,
      options: rubricChecks
        .filter(
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
            check: check as RubricCheck,
            criteria,
            options: [],
            isDisabled
          };
          if (isRubricCheckDataWithOptions(check.data)) {
            option.options = check.data.options.map((subOption, index) => ({
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
    })) as RubricCriteriaSelectGroupOption[];
  }, [rubricCriteria, rubricChecks, assignedPartIds, existingComments]);

  if (!criteriaOptions || criteriaOptions.length === 0) {
    return null;
  }

  const selectComponentsConfig: SelectComponentsConfig<
    RubricCheckSelectOption,
    false,
    RubricCriteriaSelectGroupOption
  > = {
    GroupHeading: (props) => (
      <chakraComponents.GroupHeading {...props}>
        {props.data.criteria ? `Criteria: ${props.data.label}` : <Separator />}
      </chakraComponents.GroupHeading>
    ),
    Option: (props) => (
      <chakraComponents.Option {...props}>
        {props.data.label} {props.data.check && `(${formatPoints(props.data.check)})`}
      </chakraComponents.Option>
    )
  };

  return (
    <PopoverRoot open={isOpen} onOpenChange={(details) => setIsOpen(details.open)}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          Annotate File
        </Button>
      </PopoverTrigger>
      <PopoverContent w="lg" p={4}>
        <PopoverArrow />
        <PopoverCloseTrigger />
        <PopoverTitle fontWeight="semibold">Annotate {file.name}</PopoverTitle>
        <PopoverBody>
          <VStack gap={3} align="stretch">
            <Select<RubricCheckSelectOption, false, RubricCriteriaSelectGroupOption>
              options={criteriaOptions}
              value={selectedCheckOption}
              onChange={(e) => setSelectedCheckOption(e)}
              placeholder="Select a rubric check..."
              components={selectComponentsConfig}
              isClearable
            />

            {selectedCheckOption?.check?.data &&
              typeof selectedCheckOption.check.data === "object" &&
              "options" in selectedCheckOption.check.data &&
              Array.isArray((selectedCheckOption.check.data as RubricChecksDataType).options) &&
              (selectedCheckOption.check.data as RubricChecksDataType).options.length > 0 && (
                <Select<RubricCheckSubOptions, false>
                  options={(selectedCheckOption.check.data as RubricChecksDataType).options.map((option, index) => ({
                    label: option.label,
                    comment: option.label,
                    value: index.toString(),
                    index: index.toString(),
                    points: option.points,
                    check: selectedCheckOption
                  }))}
                  value={selectedSubOption}
                  onChange={(e: RubricCheckSubOptions | null) => setSelectedSubOption(e)}
                  placeholder="Select an option..."
                  isClearable
                />
              )}

            {selectedCheckOption && (
              <>
                <Text fontSize="sm" color="fg.muted">
                  {selectedCheckOption.check?.description || "No description."}
                </Text>
                {isGraderOrInstructor && (
                  <Checkbox
                    checked={eventuallyVisible}
                    onCheckedChange={(details) => setEventuallyVisible(details.checked === true)}
                  >
                    Visible to student when submission is released
                  </Checkbox>
                )}
                <MessageInput
                  textAreaRef={messageInputRef}
                  placeholder={
                    selectedCheckOption.check?.is_comment_required ? "Comment (required)..." : "Optional comment..."
                  }
                  allowEmptyMessage={!selectedCheckOption.check?.is_comment_required}
                  defaultSingleLine={true}
                  sendButtonText="Add Annotation"
                  sendMessage={async (message) => {
                    if (file.class_id == null) {
                      toaster.error({
                        title: "Cannot add annotation",
                        description: "File is not associated with a class."
                      });
                      return;
                    }
                    if (authorProfileId == null) {
                      toaster.error({
                        title: "Cannot add annotation",
                        description: "Your profile is not available. Please refresh and try again."
                      });
                      return;
                    }

                    let points = selectedCheckOption.check?.points;
                    if (selectedSubOption) {
                      points = selectedSubOption.points;
                    }
                    let commentText = message || "";
                    if (selectedSubOption) {
                      commentText = selectedSubOption.comment + (commentText ? "\n" + commentText : "");
                    }

                    const values = {
                      comment: commentText,
                      line: MARKDOWN_FILE_COMMENT_LINE,
                      rubric_check_id: selectedCheckOption.check?.id ?? null,
                      class_id: file.class_id,
                      submission_file_id: file.id,
                      submission_id: submission.id,
                      author: authorProfileId,
                      released: submissionReview ? submissionReview.released : true,
                      points: points ?? null,
                      submission_review_id: submissionReview?.id ?? null,
                      eventually_visible:
                        selectedCheckOption.check?.student_visibility !== "never" ? eventuallyVisible : false,
                      regrade_request_id: null
                    };

                    try {
                      await submissionController.submission_file_comments.create(
                        values as Omit<
                          SubmissionFileComment,
                          "id" | "created_at" | "updated_at" | "deleted_at" | "edited_at" | "edited_by"
                        >
                      );
                      setIsOpen(false);
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
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
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
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const comments = useSubmissionFileComments({ file_id: file.id });

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
            // Binary file - fetch from Supabase Storage
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

  // Custom components for ReactMarkdown
  const components: Components = useMemo(
    () => ({
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
          <Box display="inline-block" borderWidth="1px" borderColor="border.emphasized" borderRadius="md" p={2} my={1}>
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

      // Custom code block renderer that handles mermaid
      pre: ({ children, ...props }) => {
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
      },

      // Custom table renderer for better styling
      table: ({ children, ...props }) => (
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
      ),

      // Custom checkbox rendering for task lists
      input: ({ type, checked, ...props }) => {
        if (type === "checkbox") {
          return <input type="checkbox" checked={checked} readOnly style={{ marginRight: "6px" }} {...props} />;
        }
        return <input type={type} {...props} />;
      },

      // Styled blockquote - use native element to avoid Box/blockquote type mismatch
      blockquote: ({ children }) => (
        <Box as="blockquote" borderLeftWidth="4px" borderLeftColor="blue.300" pl={4} py={1} my={2} color="fg.muted">
          {children}
        </Box>
      ),

      // Styled headings with anchor links
      h1: ({ children, ...props }) => (
        <Heading as="h1" size="2xl" mt={6} mb={3} {...props}>
          {children}
        </Heading>
      ),
      h2: ({ children, ...props }) => (
        <Heading
          as="h2"
          size="xl"
          mt={5}
          mb={2}
          borderBottomWidth="1px"
          borderColor="border.emphasized"
          pb={1}
          {...props}
        >
          {children}
        </Heading>
      ),
      h3: ({ children, ...props }) => (
        <Heading as="h3" size="lg" mt={4} mb={2} {...props}>
          {children}
        </Heading>
      ),
      h4: ({ children, ...props }) => (
        <Heading as="h4" size="md" mt={3} mb={1} {...props}>
          {children}
        </Heading>
      ),
      h5: ({ children, ...props }) => (
        <Heading as="h5" size="sm" mt={2} mb={1} {...props}>
          {children}
        </Heading>
      ),
      h6: ({ children, ...props }) => (
        <Heading as="h6" size="xs" mt={2} mb={1} {...props}>
          {children}
        </Heading>
      ),

      // Horizontal rule
      hr: ({ ...props }) => <Box as="hr" my={4} borderColor="border.emphasized" {...props} />
    }),
    [resolvedImages, file.name, fileMap, onNavigateToFile]
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
          <Box bg="green.subtle" px={2} py={0.5} borderRadius="full">
            <Text fontSize="xs" color="green.fg" fontWeight="medium">
              Preview
            </Text>
          </Box>
          {comments.length > 0 && (
            <Text fontSize="xs" color="text.subtle">
              {comments.length} {comments.length === 1 ? "comment" : "comments"}
            </Text>
          )}
        </HStack>
        {isGraderOrInstructor && <MarkdownAnnotationPopover file={file} />}
      </Flex>
      <Box p={6} className="markdown-file-preview" css={markdownPreviewStyles}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkGemoji]}
          rehypePlugins={[rehypeKatex, rehypeHighlight]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </Box>
      <Box borderTop="1px solid" borderColor="border.emphasized" p={4}>
        <MarkdownFileComments file={file} />
      </Box>
    </Box>
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
