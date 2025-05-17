"use client";

import CodeFile, {
  formatPoints,
  RubricCheckSelectOption,
  RubricCheckSubOptions,
  RubricCriteriaSelectGroupOption
} from "@/components/ui/code-file";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import PersonAvatar from "@/components/ui/person-avatar";
import {
  PopoverBody,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  PopoverArrow,
  PopoverCloseTrigger,
  PopoverTitle
} from "@/components/ui/popover";
import { CommentActions } from "@/components/ui/rubric-sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import {
  useRubricCheck,
  useSubmission,
  useSubmissionArtifactComments,
  useSubmissionFileComments,
  useSubmissionReview,
  useReviewAssignment,
  useSubmissionReviewByAssignmentId,
  useSubmissionMaybe
} from "@/hooks/useSubmission";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { createClient } from "@/utils/supabase/client";
import { Tables } from "@/utils/supabase/SupabaseTypes";
import {
  HydratedRubricCheck,
  HydratedRubricCriteria,
  SubmissionArtifact,
  SubmissionArtifactComment,
  SubmissionWithFilesGraderResultsOutputTestsAndRubric,
  SubmissionFile
} from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Button,
  ClientOnly,
  Flex,
  Heading,
  HStack,
  Icon,
  Separator,
  Spinner,
  Table,
  Tag,
  Text,
  VStack
} from "@chakra-ui/react";
import { useCreate, useInvalidate, useUpdate } from "@refinedev/core";
import { chakraComponents, Select, SelectComponentsConfig } from "chakra-react-select";
import { format } from "date-fns";
import JSZip from "jszip";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { FaCheckCircle, FaEyeSlash, FaTimesCircle } from "react-icons/fa";
import zipToHTMLBlobs from "./zipToHTMLBlobs";
import { Checkbox } from "@/components/ui/checkbox";
import { toaster } from "@/components/ui/toaster";
import NotFound from "@/components/ui/not-found";

function FilePicker({ curFile }: { curFile: number }) {
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const comments = useSubmissionFileComments({});
  const showCommentsFeature = submission.released !== null || isGraderOrInstructor;
  return (
    <Box
      maxH="250px"
      overflowY="auto"
      w="100%"
      m={2}
      css={{
        "&::-webkit-scrollbar": {
          width: "8px",
          display: "block"
        },
        "&::-webkit-scrollbar-track": {
          background: "#f1f1f1",
          borderRadius: "4px"
        },
        "&::-webkit-scrollbar-thumb": {
          background: "#888",
          borderRadius: "4px"
        },
        "&::-webkit-scrollbar-thumb:hover": {
          background: "#555"
        }
      }}
    >
      <Table.Root borderWidth="1px" borderColor="border.emphasized" w="100%" borderRadius="md">
        <Table.Header>
          <Table.Row bg="bg.subtle">
            <Table.ColumnHeader>File</Table.ColumnHeader>
            {showCommentsFeature && <Table.ColumnHeader>Comments</Table.ColumnHeader>}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {submission.submission_files.map((file, idx) => (
            <Table.Row key={file.id}>
              <Table.Cell>
                <Link
                  variant={curFile === idx ? "underline" : undefined}
                  href={`/course/${submission.assignments.class_id}/assignments/${submission.assignments.id}/submissions/${submission.id}/files/?file_id=${file.id}`}
                >
                  {file.name}
                </Link>
              </Table.Cell>
              {showCommentsFeature && (
                <Table.Cell>{comments.filter((comment) => comment.submission_file_id === file.id).length}</Table.Cell>
              )}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
function ArtifactPicker({ curArtifact }: { curArtifact: number }) {
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const comments = useSubmissionArtifactComments({});
  const showCommentsFeature = submission.released !== null || isGraderOrInstructor;
  if (!submission.submission_artifacts || submission.submission_artifacts.length === 0) {
    return <></>;
  }
  return (
    <Box
      maxH="250px"
      w="100%"
      m={2}
      overflowY="auto"
      css={{
        "&::-webkit-scrollbar": {
          width: "8px",
          display: "block"
        },
        "&::-webkit-scrollbar-track": {
          background: "#f1f1f1",
          borderRadius: "4px"
        },
        "&::-webkit-scrollbar-thumb": {
          background: "#888",
          borderRadius: "4px"
        },
        "&::-webkit-scrollbar-thumb:hover": {
          background: "#555"
        }
      }}
    >
      <Table.Root borderWidth="1px" borderColor="border.emphasized" w="100%" borderRadius="md">
        <Table.Header>
          <Table.Row bg="bg.subtle">
            <Table.ColumnHeader>Artifact</Table.ColumnHeader>
            {showCommentsFeature && <Table.ColumnHeader>Comments</Table.ColumnHeader>}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {submission.submission_artifacts.map((artifact, idx) => (
            <Table.Row key={artifact.id}>
              <Table.Cell>
                <Link
                  variant={curArtifact === idx ? "underline" : undefined}
                  href={`/course/${submission.assignments.class_id}/assignments/${submission.assignments.id}/submissions/${submission.id}/files/?artifact_id=${artifact.id}`}
                >
                  {artifact.name}
                </Link>
              </Table.Cell>
              {showCommentsFeature && (
                <Table.Cell>
                  {comments.filter((comment) => comment.submission_artifact_id === artifact.id).length}
                </Table.Cell>
              )}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}

function ArtifactAnnotation({
  comment,
  reviewAssignmentId
}: {
  comment: SubmissionArtifactComment;
  reviewAssignmentId?: number;
}) {
  const { rubricCheck, rubricCriteria } = useRubricCheck(comment.rubric_check_id);
  const commentAuthor = useUserProfile(comment.author);
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const { mutateAsync: updateComment } = useUpdate({
    resource: "submission_artifact_comments"
  });
  const { reviewAssignment, isLoading: reviewAssignmentLoading } = useReviewAssignment(reviewAssignmentId);
  const gradingReview = useSubmissionReview(comment.submission_review_id);

  if (reviewAssignmentLoading) {
    return <Skeleton height="100px" width="100%" />;
  }

  if (!rubricCheck || !rubricCriteria) {
    return <Skeleton height="100px" width="100%" />;
  }

  const reviewName = comment.submission_review_id
    ? reviewAssignment?.rubrics?.name || gradingReview?.rubrics?.name || gradingReview?.name || "Review"
    : "Self-Review";

  const pointsText = rubricCriteria.is_additive ? `+${comment.points}` : `-${comment.points}`;

  return (
    <Box m={0} p={0} w="100%" pb={1}>
      <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
        <PersonAvatar size="2xs" uid={comment.author} />
        <VStack
          alignItems="flex-start"
          spaceY={0}
          gap={0}
          w="100%"
          border="1px solid"
          borderColor="border.info"
          borderRadius="md"
        >
          <Box bg="bg.info" pl={1} pr={1} borderRadius="md" w="100%">
            <Flex w="100%" justifyContent="space-between">
              <HStack>
                {!comment.released && (
                  <Tooltip content="This comment is not released to the student yet">
                    <Icon as={FaEyeSlash} />
                  </Tooltip>
                )}
                <Icon
                  as={rubricCriteria.is_additive ? FaCheckCircle : FaTimesCircle}
                  color={rubricCriteria.is_additive ? "green.500" : "red.500"}
                />
                {pointsText}
                <Text fontSize="sm" color="fg.muted">
                  {rubricCriteria?.name} &gt; {rubricCheck?.name}
                </Text>
              </HStack>
              <HStack gap={0}>
                <Text fontSize="sm" fontStyle="italic" color="fg.muted">
                  {commentAuthor?.name} ({reviewName})
                </Text>
                <CommentActions comment={comment} setIsEditing={setIsEditing} />
              </HStack>
            </Flex>
          </Box>
          <Box pl={2}>
            <Markdown style={{ fontSize: "0.8rem" }}>{rubricCheck.description}</Markdown>
          </Box>
          <Box pl={2}>
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
function ArtifactComment({
  comment,
  submission
}: {
  comment: SubmissionArtifactComment;
  submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric;
}) {
  const authorProfile = useUserProfile(comment.author);
  const isAuthor =
    submission.profile_id === comment.author ||
    submission?.assignment_groups?.assignment_groups_members?.some((member) => member.profile_id === comment.author);
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const { mutateAsync: updateComment } = useUpdate({
    resource: "submission_artifact_comments"
  });
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
              <Text>commented on {format(comment.created_at, "MMM d, yyyy")}</Text>
            </HStack>
            <HStack>
              {isAuthor || authorProfile?.flair ? (
                <Tag.Root size="md" colorPalette={isAuthor ? "green" : "gray"} variant="surface">
                  <Tag.Label>{isAuthor ? "Author" : authorProfile?.flair}</Tag.Label>
                </Tag.Root>
              ) : (
                <></>
              )}
              <CommentActions comment={comment} setIsEditing={setIsEditing} />
            </HStack>
          </HStack>
          <Box pl={2}>
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

function ArtifactComments({
  artifact,
  reviewAssignmentId
}: {
  artifact: SubmissionArtifact;
  reviewAssignmentId?: number;
}) {
  const allArtifactComments = useSubmissionArtifactComments({});
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();

  const commentsToDisplay = useMemo(() => {
    return allArtifactComments.filter((comment) => {
      if (comment.submission_artifact_id !== artifact.id) return false;
      if (!isGraderOrInstructor && submission.released !== null) {
        return comment.eventually_visible === true;
      }
      return true;
    });
  }, [allArtifactComments, artifact.id, isGraderOrInstructor, submission.released]);

  const { reviewAssignment } = useReviewAssignment(reviewAssignmentId);

  if (!submission) {
    return null;
  }

  return (
    <Box mt={4}>
      {commentsToDisplay.map((comment) =>
        comment.rubric_check_id ? (
          <ArtifactAnnotation key={comment.id} comment={comment} reviewAssignmentId={reviewAssignmentId} />
        ) : (
          <ArtifactComment key={comment.id} comment={comment} submission={submission} />
        )
      )}
      <ArtifactCommentsForm
        submission={submission}
        artifact={artifact}
        defaultValue=""
        reviewAssignmentId={reviewAssignmentId ?? reviewAssignment?.id}
      />
    </Box>
  );
}

function ArtifactCommentsForm({
  submission,
  artifact,
  defaultValue,
  reviewAssignmentId
}: {
  submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric;
  artifact: SubmissionArtifact;
  defaultValue: string;
  reviewAssignmentId?: number;
}) {
  const invalidate = useInvalidate();
  const reviewContext = useSubmissionReview();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const [eventuallyVisible, setEventuallyVisible] = useState(true);

  const { mutateAsync: createComment } = useCreate<SubmissionArtifactComment>({
    resource: "submission_artifact_comments"
  });

  const postComment = useCallback(
    async (message: string, author_id: string) => {
      const finalReviewAssignmentId = reviewAssignmentId ?? reviewContext?.id;

      await createComment({
        values: {
          submission_id: submission.id,
          submission_artifact_id: artifact.id,
          class_id: submission.assignments.class_id,
          author: author_id,
          comment: message,
          submission_review_id: finalReviewAssignmentId,
          released: reviewContext ? reviewContext.released : true,
          eventually_visible: eventuallyVisible
        }
      });
      invalidate({ resource: "submission_artifacts", id: artifact.id, invalidates: ["detail"] });
    },
    [createComment, submission, artifact, invalidate, reviewContext, eventuallyVisible, reviewAssignmentId]
  );

  return (
    <Box w="100%">
      <MessageInput
        className="w-full p-2 border rounded"
        defaultSingleLine={true}
        sendMessage={postComment}
        sendButtonText="Save"
        defaultValue={defaultValue}
      />
      {isGraderOrInstructor && (
        <Box mt={2}>
          <Checkbox
            checked={eventuallyVisible}
            onCheckedChange={(details) => setEventuallyVisible(details.checked === true)}
          >
            Visible to student upon release
          </Checkbox>
        </Box>
      )}
    </Box>
  );
}
function ArtifactCheckPopover({
  artifact,
  reviewAssignmentId
}: {
  artifact: SubmissionArtifact;
  reviewAssignmentId?: number;
}) {
  const submission = useSubmission();
  const reviewContext = useSubmissionReview();
  const [selectedCheckOption, setSelectedCheckOption] = useState<RubricCheckSelectOption | null>(null);
  const [selectedSubOption, setSelectedSubOption] = useState<RubricCheckSubOptions | null>(null);

  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const [eventuallyVisible, setEventuallyVisible] = useState(true);
  const [isOpen, setIsOpen] = useState(false);

  const { mutateAsync: createComment } = useCreate<SubmissionArtifactComment>({
    resource: "submission_artifact_comments"
  });

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

  const criteriaWithArtifactAnnotationChecks = submission.assignments.rubrics?.rubric_criteria.filter((criteria) =>
    criteria.rubric_checks.some((check) => check.is_annotation && check.annotation_target === "artifact")
  );

  const criteriaOptions: RubricCriteriaSelectGroupOption[] =
    (criteriaWithArtifactAnnotationChecks?.map((criteria) => ({
      label: criteria.name,
      value: criteria.id.toString(),
      criteria: criteria as HydratedRubricCriteria,
      options: (
        criteria.rubric_checks.filter(
          (check) => check.is_annotation && check.annotation_target === "artifact"
        ) as HydratedRubricCheck[]
      ).map((check) => {
        const option: RubricCheckSelectOption = {
          label: check.name,
          value: check.id.toString(),
          check,
          criteria: criteria as HydratedRubricCriteria,
          options: []
        };
        if (check.data?.options) {
          option.options = check.data.options.map((subOption, index) => ({
            label: (criteria.is_additive ? "+" : "-") + subOption.points + " " + subOption.label,
            comment: subOption.label,
            index: index.toString(),
            value: index.toString(),
            points: subOption.points,
            check: option
          }));
        }
        return option;
      })
    })) as RubricCriteriaSelectGroupOption[]) || [];

  if (!criteriaOptions || criteriaOptions.length === 0) {
    return (
      <Text fontSize="sm" color="fg.muted">
        No rubric checks available for artifact annotation.
      </Text>
    );
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
          Annotate Artifact
        </Button>
      </PopoverTrigger>
      <PopoverContent w="lg" p={4}>
        <PopoverArrow />
        <PopoverCloseTrigger />
        <PopoverTitle fontWeight="semibold">Annotate {artifact.name} (Line numbers not applicable)</PopoverTitle>
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

            {selectedCheckOption?.check?.data?.options && selectedCheckOption.check.data.options.length > 0 && (
              <Select<RubricCheckSubOptions, false>
                options={selectedCheckOption.check.data.options.map((option, index) => ({
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
                    Visible to student upon release
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
                  sendMessage={async (message, profile_id) => {
                    let points = selectedCheckOption.check?.points;
                    if (selectedSubOption) {
                      points = selectedSubOption.points;
                    }
                    let commentText = message || "";
                    if (selectedSubOption) {
                      commentText = selectedSubOption.comment + (commentText ? "\n" + commentText : "");
                    }

                    const finalReviewAssignmentId = reviewAssignmentId ?? reviewContext?.id;

                    if (!finalReviewAssignmentId && selectedCheckOption.check?.id) {
                      toaster.error({
                        title: "Error saving comment",
                        description: "Submission review ID is missing for rubric annotation on artifact."
                      });
                      return;
                    }

                    const values = {
                      comment: commentText,
                      rubric_check_id: selectedCheckOption.check?.id,
                      class_id: submission.assignments.class_id,
                      submission_id: submission.id,
                      submission_artifact_id: artifact.id,
                      author: profile_id,
                      released: reviewContext ? reviewContext.released : true,
                      points,
                      submission_review_id: finalReviewAssignmentId,
                      eventually_visible: eventuallyVisible
                    };
                    await createComment({ values });
                    setIsOpen(false);
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
function ArtifactWithComments({
  artifact,
  reviewAssignmentId
}: {
  artifact: SubmissionArtifact;
  reviewAssignmentId?: number;
}) {
  return (
    <Box key={artifact.id} borderWidth="1px" borderRadius="lg" p={4} w="100%">
      <Heading size="lg" mb={2}>
        {artifact.name}
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={2}>
        Type: {artifact.data?.format}, Display: {artifact.data?.display}
      </Text>

      <ArtifactCheckPopover artifact={artifact} reviewAssignmentId={reviewAssignmentId} />

      <ArtifactView artifact={artifact} />
      <ArtifactComments artifact={artifact} reviewAssignmentId={reviewAssignmentId} />
    </Box>
  );
}
function ArtifactView({ artifact }: { artifact: SubmissionArtifact }) {
  // Load the artifact data from supabase
  const [artifactData, setArtifactData] = useState<Blob | null>(null);
  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  const artifactKey = `classes/${artifact.class_id}/profiles/${artifact.profile_id ? artifact.profile_id : artifact.assignment_group_id}/submissions/${artifact.submission_id}/${artifact.id}`;
  useEffect(() => {
    let cleanup: (() => void) | undefined = undefined;
    async function loadArtifact() {
      const client = createClient();
      const data = await client.storage.from("submission-artifacts").download(artifactKey);
      if (data.data) {
        setArtifactData(data.data);
        if (artifact.data.format === "zip" && artifact.data.display === "html_site") {
          try {
            // TODO this will NEVER work in safari, we need to just unzip it on a server and serve the files
            const zip = await JSZip.loadAsync(data.data);
            const { rewrittenHTMLFiles, topLevelDir } = await zipToHTMLBlobs(data.data);
            const listener = async (event: MessageEvent) => {
              if (event.data.type === "REQUEST_FILE_CONTENTS") {
                // Create a map of file contents
                const fileContents: Record<string, string | Uint8Array> = {};
                // Find the top level directory
                // Process all files in parallel
                await Promise.all(
                  Object.entries(zip.files).map(async ([path, file]) => {
                    const pathRelativeToTopLevelDir = path.replace(topLevelDir, "");
                    if (!file.dir) {
                      // Get the content based on file type
                      if (pathRelativeToTopLevelDir.endsWith(".html")) {
                        fileContents[pathRelativeToTopLevelDir] = rewrittenHTMLFiles.get(pathRelativeToTopLevelDir)!;
                      } else if (
                        pathRelativeToTopLevelDir.endsWith(".css") ||
                        pathRelativeToTopLevelDir.endsWith(".js") ||
                        pathRelativeToTopLevelDir.endsWith(".json")
                      ) {
                        fileContents[pathRelativeToTopLevelDir] = await file.async("text");
                      } else {
                        fileContents[pathRelativeToTopLevelDir] = await file.async("uint8array");
                      }
                    }
                  })
                );
                // Send all file contents to the iframe
                event.source?.postMessage(
                  {
                    type: "FILE_CONTENTS_RESPONSE",
                    fileContents
                  },
                  { targetOrigin: "*" }
                );
              }
            };
            window.addEventListener("message", listener);
            cleanup = () => {
              window.removeEventListener("message", listener);
            };
            if (rewrittenHTMLFiles.get("/index.html")) {
              const url = URL.createObjectURL(
                new Blob([rewrittenHTMLFiles.get("/index.html")!], { type: "text/html" })
              );
              setSiteUrl(url);
            }
          } catch (error) {
            toaster.error({
              title: "Error processing ZIP file: " + error,
              description: "Please try again."
            });
          }
        }
      }
      if (data.error) {
        toaster.error({
          title: "Error processing ZIP file: " + data.error,
          description: "Please try again."
        });
      }
    }
    loadArtifact();
    return () => {
      if (cleanup) {
        cleanup();
      }
    };
  }, [artifactKey, artifact.data?.display, artifact.data?.format]);
  if (artifact.data.format === "png") {
    if (artifactData) {
      return <Image src={URL.createObjectURL(artifactData)} alt={artifact.name} />;
    } else {
      return <Spinner />;
    }
  } else if (artifact.data.format === "zip") {
    if (artifact.data.display === "html_site") {
      if (siteUrl) {
        return (
          <Box>
            <ClientOnly>
              <Box borderWidth="1px" borderColor="border.emphasized" borderRadius="md" overflow="hidden">
                <iframe
                  src={siteUrl}
                  className="w-full h-full border-none min-h-[500px]"
                  title={artifact.name}
                  sandbox="allow-scripts"
                />
              </Box>
            </ClientOnly>
          </Box>
        );
      } else {
        return <Spinner />;
      }
    }
  }
  return (
    <Box>
      <Text>{artifact.name}</Text>
    </Box>
  );
}

export default function FilesView() {
  const searchParams = useSearchParams();
  const submissionData = useSubmissionMaybe();
  const isLoadingSubmission = submissionData === undefined;

  const reviewAssignmentIdFromQuery = searchParams.get("review_assignment_id");
  const { reviewAssignment, isLoading: isLoadingReviewAssignment } = useReviewAssignment(
    reviewAssignmentIdFromQuery ? Number(reviewAssignmentIdFromQuery) : undefined
  );

  const { submissionReview: currentSubmissionReview, isLoading: isLoadingSubmissionReviewList } =
    useSubmissionReviewByAssignmentId(reviewAssignmentIdFromQuery ? Number(reviewAssignmentIdFromQuery) : undefined);

  const currentSubmissionReviewRecordId = currentSubmissionReview?.id;

  const activeSubmissionReviewIdToUse = reviewAssignmentIdFromQuery
    ? currentSubmissionReviewRecordId
    : submissionData?.grading_review_id;

  const fileId = searchParams.get("file_id");
  const artifactId = searchParams.get("artifact_id");

  const curFileIndex = submissionData?.submission_files.findIndex((file: SubmissionFile) => file.id === Number(fileId));
  const selectedFile =
    curFileIndex !== undefined && curFileIndex !== -1
      ? submissionData?.submission_files[curFileIndex]
      : submissionData?.submission_files[0];

  const curArtifactIndex = submissionData?.submission_artifacts?.findIndex(
    (artifact: Tables<"submission_artifacts">) => artifact.id === Number(artifactId)
  );
  const selectedArtifact =
    curArtifactIndex !== undefined && curArtifactIndex !== -1
      ? submissionData?.submission_artifacts?.[curArtifactIndex]
      : submissionData?.submission_artifacts?.[0];

  const isLoading =
    isLoadingSubmission || isLoadingReviewAssignment || (!!reviewAssignment && isLoadingSubmissionReviewList);

  // Resolve prop types
  const filePickerDisplayIndex = curFileIndex === undefined || curFileIndex === -1 ? 0 : curFileIndex;
  const artifactPickerDisplayIndex = curArtifactIndex === undefined || curArtifactIndex === -1 ? 0 : curArtifactIndex;
  const finalActiveSubmissionReviewId =
    activeSubmissionReviewIdToUse === null ? undefined : activeSubmissionReviewIdToUse;

  if (isLoading) {
    return <Spinner />;
  }

  const submission = submissionData;

  if (!submission) {
    return <NotFound />;
  }

  return (
    <>
      <Flex pt={{ base: "sm", md: "0" }} gap={{ base: "0", md: "6" }} direction={{ base: "column", md: "row" }}>
        <Box w={{ base: "100%", md: "300px" }} minW={{ base: "100%", md: "300px" }}>
          <FilePicker curFile={filePickerDisplayIndex} />
          {submission.submission_artifacts && submission.submission_artifacts.length > 0 && (
            <ArtifactPicker curArtifact={artifactPickerDisplayIndex} />
          )}
        </Box>
        <Separator orientation={{ base: "horizontal", md: "vertical" }} />
        <Box flex="1" overflow="auto">
          {fileId ||
          (curFileIndex === -1 && curArtifactIndex === -1 && submission.submission_files.length > 0 && selectedFile) ? (
            selectedFile && <CodeFile file={selectedFile} submissionReviewId={finalActiveSubmissionReviewId} />
          ) : selectedArtifact ? (
            selectedArtifact.data !== null ? (
              <ArtifactWithComments
                artifact={selectedArtifact as SubmissionArtifact}
                reviewAssignmentId={finalActiveSubmissionReviewId}
              />
            ) : (
              <ArtifactView artifact={selectedArtifact as SubmissionArtifact} />
            )
          ) : (
            <Text>Select a file or artifact to view.</Text>
          )}
        </Box>
      </Flex>
    </>
  );
}
