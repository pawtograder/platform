"use client";

import { Checkbox } from "@/components/ui/checkbox";
import CodeFile, {
  formatPoints,
  RubricCheckSelectOption,
  RubricCheckSubOptions,
  RubricCriteriaSelectGroupOption
} from "@/components/ui/code-file";
import DownloadLink from "@/components/ui/download-link";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import NotFound from "@/components/ui/not-found";
import PersonAvatar from "@/components/ui/person-avatar";
import {
  PopoverArrow,
  PopoverBody,
  PopoverCloseTrigger,
  PopoverContent,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger
} from "@/components/ui/popover";
import { CommentActions, StudentVisibilityIndicator } from "@/components/ui/rubric-sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import {
  useAssignmentController,
  useReviewAssignment,
  useRubricById,
  useRubricChecksByRubric,
  useRubricCriteriaByRubric,
  useRubricWithParts
} from "@/hooks/useAssignment";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import {
  useRubricCheck,
  useSubmission,
  useSubmissionArtifactComments,
  useSubmissionController,
  useSubmissionFileComments,
  useSubmissionMaybe,
  useSubmissionReview,
  useSubmissionReviewOrGradingReview,
  useWritableSubmissionReviews
} from "@/hooks/useSubmission";
import { useActiveReviewAssignmentId, useActiveRubricId } from "@/hooks/useSubmissionReview";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useFindTableControllerValue } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  HydratedRubricCriteria,
  RubricCheck,
  RubricChecksDataType,
  SubmissionArtifact,
  SubmissionArtifactComment,
  SubmissionFile,
  SubmissionWithGraderResultsAndFiles
} from "@/utils/supabase/DatabaseTypes";
import { Tables } from "@/utils/supabase/SupabaseTypes";
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
import { useUpdate } from "@refinedev/core";
import { chakraComponents, Select, SelectComponentsConfig } from "chakra-react-select";
import { format } from "date-fns";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaCheckCircle, FaDownload, FaEyeSlash, FaTimesCircle } from "react-icons/fa";

function FilePicker({ curFile, onSelect }: { curFile: number; onSelect: (fileId: number) => void }) {
  const submission = useSubmission();
  const comments = useSubmissionFileComments({});
  const showCommentsFeature = true; //submission.released !== null || isGraderOrInstructor;
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
                  href={`/course/${submission.class_id}/assignments/${submission.assignment_id}/submissions/${submission.id}/files/?file_id=${file.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onSelect(file.id);
                  }}
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
function ArtifactPicker({ curArtifact, onSelect }: { curArtifact: number; onSelect: (artifactId: number) => void }) {
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const comments = useSubmissionArtifactComments({});
  const { assignment } = useAssignmentController();
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
                  href={`/course/${assignment.class_id}/assignments/${assignment.id}/submissions/${submission.id}/files/?artifact_id=${artifact.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onSelect(artifact.id);
                  }}
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
  const reviewAssignment = useReviewAssignment(reviewAssignmentId);
  const rubric = useRubricById(reviewAssignment?.rubric_id);

  if (comment.submission_review_id && !rubric) {
    return <Skeleton height="100px" width="100%" />;
  }

  if (!rubricCheck || !rubricCriteria) {
    return <Skeleton height="100px" width="100%" />;
  }

  const reviewName = comment.submission_review_id ? rubric?.name || "Grading Review" || "Review" : "Self-Review";

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
                <StudentVisibilityIndicator check={rubricCheck} isApplied={true} isReleased={comment.released} />
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
  submission: SubmissionWithGraderResultsAndFiles;
}) {
  const authorProfile = useUserProfile(comment.author);
  const { assignment } = useAssignmentController();
  const { assignmentGroupsWithMembers: assignmentGroupsWithMembersController } = useCourseController();
  const assignmentGroupWithMembers = useFindTableControllerValue(
    assignmentGroupsWithMembersController,
    (group) =>
      group.assignment_id === assignment.id &&
      group.assignment_groups_members.some((member) => member.profile_id === comment.author)
  );
  const isAuthor = submission.profile_id === comment.author || !!assignmentGroupWithMembers;
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
              <Text data-visual-test="blackout">commented on {format(comment.created_at, "MMM d, yyyy")}</Text>
            </HStack>
            <HStack>
              {isAuthor || authorProfile?.flair ? (
                <Tag.Root size="md" colorPalette={isAuthor ? "green" : authorProfile?.flair_color} variant="surface">
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
  reviewAssignmentId,
  submissionReviewId
}: {
  artifact: SubmissionArtifact;
  reviewAssignmentId?: number;
  submissionReviewId?: number;
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
        submissionReviewId={submissionReviewId}
      />
    </Box>
  );
}

/**
 * Renders a form for posting new comments on a submission artifact.
 *
 * Allows users to enter and submit a comment, with graders and instructors able to control whether the comment becomes visible to students upon submission release. Throws an error if the submission lacks a grading review ID.
 */
function ArtifactCommentsForm({
  submission,
  artifact,
  defaultValue,
  submissionReviewId
}: {
  submission: SubmissionWithGraderResultsAndFiles;
  artifact: SubmissionArtifact;
  defaultValue: string;
  submissionReviewId?: number;
}) {
  if (!submission.grading_review_id) {
    throw new Error("No grading review ID found");
  }
  const reviewContext = useSubmissionReviewOrGradingReview(submission.grading_review_id);
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const [eventuallyVisible, setEventuallyVisible] = useState(true);
  const submissionController = useSubmissionController();

  const postComment = useCallback(
    async (message: string, author_id: string) => {
      const finalSubmissionReviewId = submissionReviewId ?? reviewContext?.id;

      await submissionController.submission_artifact_comments.create({
        submission_id: submission.id,
        submission_artifact_id: artifact.id,
        class_id: submission.class_id,
        author: author_id,
        comment: message,
        submission_review_id: finalSubmissionReviewId ?? null,
        released: reviewContext ? reviewContext.released : true,
        eventually_visible: eventuallyVisible,
        rubric_check_id: null,
        points: null,
        regrade_request_id: null
      });
    },
    [submissionController, submission, artifact, reviewContext, eventuallyVisible, submissionReviewId]
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
            Visible to student when submission is released
          </Checkbox>
        </Box>
      )}
    </Box>
  );
}

/**
 * Displays a popover UI for annotating an artifact with a rubric check and optional comment.
 *
 * Allows graders or instructors to select a rubric check, optionally choose a sub-option, set visibility to students, and add a comment annotation to the artifact. Only rubric checks configured for artifact annotation are available. Throws an error if the grading review ID is missing.
 */
function ArtifactCheckPopover({
  artifact,
  submissionReviewId
}: {
  artifact: SubmissionArtifact;
  submissionReviewId?: number;
}) {
  const submission = useSubmission();
  if (!submission.grading_review_id) {
    throw new Error("No grading review ID found");
  }
  const reviewContext = useSubmissionReviewOrGradingReview(submission.grading_review_id);
  const rubric = useRubricWithParts(reviewContext?.rubric_id);
  const rubricCriteria = useRubricCriteriaByRubric(rubric?.id);
  const rubricChecks = useRubricChecksByRubric(rubric?.id);

  const [selectedCheckOption, setSelectedCheckOption] = useState<RubricCheckSelectOption | null>(null);
  const [selectedSubOption, setSelectedSubOption] = useState<RubricCheckSubOptions | null>(null);
  const submissionController = useSubmissionController();

  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const [eventuallyVisible, setEventuallyVisible] = useState(true);
  const [isOpen, setIsOpen] = useState(false);

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

  // Filter criteria that have annotation checks targeting artifacts
  const criteriaWithArtifactAnnotationChecks = useMemo(() => {
    if (!rubricCriteria || !rubricChecks) return [];

    const annotationChecks = rubricChecks
      .filter((check) => check.is_annotation && check.annotation_target === "artifact")
      .map((check) => check.rubric_criteria_id);

    return rubricCriteria
      .filter((criteria) => annotationChecks.includes(criteria.id))
      .sort((a, b) => a.ordinal - b.ordinal);
  }, [rubricCriteria, rubricChecks]);

  const criteriaOptions: RubricCriteriaSelectGroupOption[] = useMemo(() => {
    if (!criteriaWithArtifactAnnotationChecks || !rubricChecks) return [];

    return criteriaWithArtifactAnnotationChecks.map((criteria) => ({
      label: criteria.name,
      value: criteria.id.toString(),
      criteria: criteria as HydratedRubricCriteria,
      options: rubricChecks
        .filter(
          (check) =>
            check.is_annotation && check.annotation_target === "artifact" && check.rubric_criteria_id === criteria.id
        )
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((check) => {
          const option: RubricCheckSelectOption = {
            label: check.name,
            value: check.id.toString(),
            check: check as RubricCheck,
            criteria,
            options: []
          };
          if (
            check.data &&
            typeof check.data === "object" &&
            "options" in check.data &&
            Array.isArray((check.data as RubricChecksDataType).options)
          ) {
            const optionsData = check.data as RubricChecksDataType;
            option.options = optionsData.options.map((subOption, index) => ({
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
    })) as RubricCriteriaSelectGroupOption[];
  }, [criteriaWithArtifactAnnotationChecks, rubricChecks]);

  if (!criteriaOptions || criteriaOptions.length === 0) {
    return (
      <Text fontSize="sm" color="fg.muted">
        No rubric checks available for this artifact.
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
        <Button variant="outline" size="sm" my={2}>
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
                  sendMessage={async (message, profile_id) => {
                    let points = selectedCheckOption.check?.points;
                    if (selectedSubOption) {
                      points = selectedSubOption.points;
                    }
                    let commentText = message || "";
                    if (selectedSubOption) {
                      commentText = selectedSubOption.comment + (commentText ? "\n" + commentText : "");
                    }

                    const finalSubmissionReviewId = submissionReviewId ?? reviewContext?.id;

                    if (!finalSubmissionReviewId && selectedCheckOption.check?.id) {
                      toaster.error({
                        title: "Error saving comment",
                        description: "Submission review ID is missing for rubric annotation on artifact."
                      });
                      return;
                    }

                    const values = {
                      comment: commentText,
                      rubric_check_id: selectedCheckOption.check?.id ?? null,
                      class_id: submission.class_id,
                      submission_id: submission.id,
                      submission_artifact_id: artifact.id,
                      author: profile_id,
                      released: reviewContext ? reviewContext.released : true,
                      points: points ?? null,
                      submission_review_id: finalSubmissionReviewId ?? null,
                      eventually_visible: eventuallyVisible,
                      regrade_request_id: null
                    };
                    await submissionController.submission_artifact_comments.create(values);
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
  reviewAssignmentId,
  submissionReviewId
}: {
  artifact: SubmissionArtifact;
  reviewAssignmentId?: number;
  submissionReviewId?: number;
}) {
  return (
    <Box key={artifact.id} borderWidth="1px" borderRadius="lg" p={4} w="100%">
      <Heading size="lg" mb={2}>
        {artifact.name}
      </Heading>

      <ArtifactCheckPopover artifact={artifact} submissionReviewId={submissionReviewId} />

      <ArtifactView artifact={artifact} />
      <ArtifactComments
        artifact={artifact}
        reviewAssignmentId={reviewAssignmentId}
        submissionReviewId={submissionReviewId}
      />
    </Box>
  );
}
function RenderedArtifact({ artifact, artifactKey }: { artifact: SubmissionArtifact; artifactKey: string }) {
  const [artifactData, setArtifactData] = useState<Blob | null>(null);
  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadArtifact() {
      const client = createClient();
      if (artifact.data.format === "zip" && artifact.data.display === "html_site") {
        const data = await client.functions.invoke("submission-serve-artifact", {
          body: JSON.stringify({
            classId: artifact.class_id,
            submissionId: artifact.submission_id,
            artifactId: artifact.id
          })
        });
        setSiteUrl(data.data.url);
      }
      const data = await client.storage.from("submission-artifacts").download(artifactKey);

      if (!isMounted) return; // Component unmounted, exit early

      if (data.data) {
        setArtifactData(data.data);
      }
      if (data.error && isMounted) {
        toaster.error({
          title: "Error processing ZIP file: " + data.error,
          description: "Please try again."
        });
      }
    }

    loadArtifact();

    return () => {
      isMounted = false;
    };
  }, [
    artifactKey,
    artifact.data?.display,
    artifact.data?.format,
    artifact.class_id,
    artifact.submission_id,
    artifact.id
  ]);

  // Create object URL when artifactData changes and cleanup previous URL
  useEffect(() => {
    let newObjectUrl: string | null = null;
    if (artifactData && artifact.data.format === "png") {
      newObjectUrl = URL.createObjectURL(artifactData);
      setObjectUrl(newObjectUrl);
    }

    return () => {
      // Cleanup on unmount or when artifactData changes
      if (newObjectUrl) {
        URL.revokeObjectURL(newObjectUrl);
      }
    };
  }, [artifactData, artifact.data?.format]);

  if (artifact.data.format === "png") {
    if (objectUrl) {
      return (
        //eslint-disable-next-line @next/next/no-img-element
        <img
          src={objectUrl}
          alt={artifact.name}
          style={{
            maxWidth: "100%",
            height: "auto",
            display: "block"
          }}
        />
      );
    } else {
      return <Spinner />;
    }
  } else if (artifact.data.format === "zip") {
    if (artifact.data.display === "html_site") {
      if (siteUrl) {
        return (
          <Box>
            <ClientOnly>
              <div
                style={{
                  border: "1px solid var(--chakra-colors-border-emphasized)",
                  borderRadius: "0.375rem",
                  overflow: "auto",
                  resize: "both",
                  height: "400px",
                  minHeight: "300px",
                  minWidth: "300px",
                  width: "100%",
                  maxWidth: "100%"
                }}
              >
                <iframe
                  src={siteUrl}
                  className="border-none"
                  style={{
                    width: "100%",
                    height: "100%",
                    display: "block",
                    border: "none"
                  }}
                  title={artifact.name}
                  sandbox="allow-scripts"
                />
              </div>
            </ClientOnly>
          </Box>
        );
      } else {
        return <Spinner />;
      }
    }
  } else {
    return <>No preview available for artifacts of type {artifact.data.format}.</>;
  }
}

function ArtifactView({ artifact }: { artifact: SubmissionArtifact }) {
  const artifactKey = `classes/${artifact.class_id}/profiles/${artifact.profile_id ? artifact.profile_id : artifact.assignment_group_id}/submissions/${artifact.submission_id}/${artifact.id}`;
  // Load the artifact data from supabase
  const [downloadLink, setDownloadLink] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  useEffect(() => {
    let isMounted = true;
    async function loadArtifact() {
      const client = createClient();
      const { data, error } = await client.storage
        .from("submission-artifacts")
        .createSignedUrl(artifactKey, 60 * 60 * 24 * 30);
      if (!isMounted) return;
      if (error) {
        setDownloadError(`Error downloading artifact: ${error.message}`);
        return;
      }
      setDownloadLink(data.signedUrl);
    }
    loadArtifact();
    return () => {
      isMounted = false;
    };
  }, [artifactKey]);
  if (downloadError) {
    return <Text color="fg.error">{downloadError}</Text>;
  }

  if (artifact.data) {
    return (
      <Box w="100%">
        {downloadLink && (
          <DownloadLink href={downloadLink} filename={artifact.name} mb={2}>
            <Icon as={FaDownload} mr={2} /> Download {artifact.name}
          </DownloadLink>
        )}
        <RenderedArtifact artifact={artifact} artifactKey={artifactKey} />
      </Box>
    );
  } else if (downloadLink) {
    return (
      <DownloadLink href={downloadLink} filename={artifact.name}>
        Download {artifact.name} (Hint: add artifact.data to get a better grading experience)
      </DownloadLink>
    );
  } else {
    return <Spinner />;
  }
}

export default function FilesView() {
  const searchParams = useSearchParams();
  const submissionData = useSubmissionMaybe();
  const isLoadingSubmission = submissionData === undefined;

  const { activeRubricId } = useActiveRubricId();
  const writableSubmissionReviews = useWritableSubmissionReviews(activeRubricId);

  const activeReviewAssignmentId = useActiveReviewAssignmentId();
  const reviewAssignment = useReviewAssignment(activeReviewAssignmentId);

  const currentSubmissionReview = useSubmissionReview(reviewAssignment?.submission_review_id);

  const currentSubmissionReviewRecordId = currentSubmissionReview?.id;

  const activeSubmissionReviewIdToUse = activeReviewAssignmentId
    ? (reviewAssignment?.submission_review_id ?? currentSubmissionReviewRecordId)
    : writableSubmissionReviews?.[0]?.id;

  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<number | null>(null);
  const [isSwitching, setIsSwitching] = useState<boolean>(false);
  const scrolledTargetsRef = useRef<Set<string>>(new Set());

  const updateUrl = useCallback((next: { fileId?: number | null; artifactId?: number | null; hash?: string }) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next.fileId !== undefined) {
      if (next.fileId === null) url.searchParams.delete("file_id");
      else url.searchParams.set("file_id", String(next.fileId));
      url.searchParams.delete("artifact_id");
    }
    if (next.artifactId !== undefined) {
      if (next.artifactId === null) url.searchParams.delete("artifact_id");
      else url.searchParams.set("artifact_id", String(next.artifactId));
      url.searchParams.delete("file_id");
    }
    url.hash = next.hash || "";
    window.history.replaceState({}, "", url.toString());
  }, []);

  const getScrollableAncestor = useCallback((element: HTMLElement | null): HTMLElement | null => {
    let node: HTMLElement | null = element;
    while (node) {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY;
      const canScroll = (overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight;
      if (canScroll) return node;
      node = node.parentElement;
    }
    return null;
  }, []);

  const preciseScrollTo = useCallback(
    (element: HTMLElement, marginTop = 80) => {
      const container = getScrollableAncestor(element);
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();
        const newTop = container.scrollTop + (elRect.top - containerRect.top) - marginTop;
        container.scrollTo({ top: newTop });
      } else {
        const elTop = element.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: elTop - marginTop });
      }
    },
    [getScrollableAncestor]
  );

  const scrollToHash = useCallback(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash) return;
    const id = hash.startsWith("#") ? hash.slice(1) : hash;
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) preciseScrollTo(el);
    });
  }, [preciseScrollTo]);

  useEffect(() => {
    const fileIdParam = searchParams.get("file_id");
    const artifactIdParam = searchParams.get("artifact_id");
    setSelectedFileId(fileIdParam ? Number(fileIdParam) : null);
    setSelectedArtifactId(artifactIdParam ? Number(artifactIdParam) : null);
    // Only run once on mount; subsequent changes are managed locally without navigation
    // Scrolling is handled by the dedicated useEffect below
  }, [searchParams]);

  useEffect(() => {
    function handleSelect(event: Event) {
      const detail = (event as CustomEvent).detail as { fileId?: number; artifactId?: number; hash?: string };
      if (detail && Object.prototype.hasOwnProperty.call(detail, "fileId")) {
        const nextId = detail.fileId ?? null;
        const isSame = nextId === selectedFileId && selectedArtifactId === null;
        updateUrl({ fileId: nextId, hash: detail.hash });
        if (isSame) {
          // Only hash changed or same file; no skeleton, just scroll if provided
          if (detail.hash) scrollToHash();
        } else {
          setIsSwitching(true);
          setSelectedFileId(nextId);
          setSelectedArtifactId(null);
        }
      } else if (detail && Object.prototype.hasOwnProperty.call(detail, "artifactId")) {
        const nextId = detail.artifactId ?? null;
        const isSame = nextId === selectedArtifactId && selectedFileId === null;
        updateUrl({ artifactId: nextId, hash: detail.hash });
        if (isSame) {
          if (detail.hash) scrollToHash();
        } else {
          setIsSwitching(true);
          setSelectedArtifactId(nextId);
          setSelectedFileId(null);
        }
      }
    }
    window.addEventListener("pawto:files-select", handleSelect as EventListener);
    return () => window.removeEventListener("pawto:files-select", handleSelect as EventListener);
  }, [updateUrl, selectedFileId, selectedArtifactId, scrollToHash]);

  const handleSelectFile = useCallback(
    (id: number) => {
      const isSame = id === selectedFileId && selectedArtifactId === null;
      updateUrl({ fileId: id, hash: "" });
      if (!isSame) {
        setIsSwitching(true);
        setSelectedFileId(id);
        setSelectedArtifactId(null);
      }
    },
    [updateUrl, selectedFileId, selectedArtifactId]
  );

  const handleSelectArtifact = useCallback(
    (id: number) => {
      const isSame = id === selectedArtifactId && selectedFileId === null;
      updateUrl({ artifactId: id, hash: "" });
      if (!isSame) {
        setIsSwitching(true);
        setSelectedArtifactId(id);
        setSelectedFileId(null);
      }
    },
    [updateUrl, selectedArtifactId, selectedFileId]
  );

  const curFileIndex =
    submissionData?.submission_files.findIndex((file: SubmissionFile) => file.id === (selectedFileId ?? -1)) ?? -1;
  const selectedFile =
    curFileIndex !== -1
      ? submissionData?.submission_files[curFileIndex]
      : submissionData?.submission_files && submissionData.submission_files.length > 0
        ? submissionData.submission_files[0]
        : undefined;

  const curArtifactIndex =
    submissionData?.submission_artifacts?.findIndex(
      (artifact: Tables<"submission_artifacts">) => artifact.id === (selectedArtifactId ?? -1)
    ) ?? -1;
  const selectedArtifact =
    curArtifactIndex !== -1
      ? submissionData?.submission_artifacts?.[curArtifactIndex]
      : submissionData?.submission_artifacts && submissionData.submission_artifacts.length > 0
        ? submissionData.submission_artifacts[0]
        : undefined;

  const isLoading = isLoadingSubmission || (!!reviewAssignment && currentSubmissionReview === undefined);

  // Resolve prop types
  const filePickerDisplayIndex = curFileIndex === -1 ? 0 : curFileIndex;
  const artifactPickerDisplayIndex = curArtifactIndex === -1 ? 0 : curArtifactIndex;
  const finalActiveSubmissionReviewId =
    activeSubmissionReviewIdToUse === null ? undefined : activeSubmissionReviewIdToUse;

  // Scroll to line anchors when hash is present and relevant content is rendered
  useEffect(() => {
    scrollToHash();
  }, [selectedFileId, selectedArtifactId, scrollToHash]);

  // Scroll to top of file/artifact when navigating via URL params (file_id or artifact_id)
  useEffect(() => {
    if (isSwitching) return; // Wait until content is rendered
    if (typeof window === "undefined") return;

    // Only scroll if there's no hash (hash scrolling is handled separately)
    const hash = window.location.hash;
    if (hash) return;

    // Determine which selector to use based on which ID is set (using !== null to handle 0 correctly)
    const selector =
      selectedFileId !== null
        ? `[data-file-id="${selectedFileId}"]`
        : selectedArtifactId !== null
          ? `[data-artifact-id="${selectedArtifactId}"]`
          : null;

    if (!selector) return; // No valid ID to scroll to

    // Scroll function that finds the element and scrolls to it
    const scrollToTop = (element: HTMLElement) => {
      const container = getScrollableAncestor(element);
      if (container) {
        // Scroll container so element is at the top
        const containerRect = container.getBoundingClientRect();
        const elRect = element.getBoundingClientRect();
        const scrollTop = container.scrollTop + (elRect.top - containerRect.top);
        container.scrollTo({ top: scrollTop, behavior: "auto" });
      } else {
        // Scroll window so element is at the top
        const elTop = element.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: elTop, behavior: "auto" });
      }
    };

    // Retry logic to handle cases where element isn't rendered yet
    let attempts = 0;
    const maxAttempts = 60; // up to ~3s at 50ms intervals
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let rafId: number | null = null;
    let scrollTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const tryScroll = () => {
      const targetElement = document.querySelector(selector);
      if (targetElement instanceof HTMLElement) {
        // Element found, scroll to it
        rafId = requestAnimationFrame(() => {
          scrollTimeoutId = setTimeout(() => {
            scrollToTop(targetElement);
          }, 50);
        });
        return;
      }

      // Element not found yet, retry if we haven't exceeded max attempts
      if (attempts++ < maxAttempts) {
        timeoutId = setTimeout(tryScroll, 50);
      }
    };

    // Start the retry loop
    tryScroll();

    // Cleanup function
    return () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (scrollTimeoutId !== null) {
        clearTimeout(scrollTimeoutId);
      }
    };
  }, [isSwitching, selectedFileId, selectedArtifactId, getScrollableAncestor]);

  // After switching to a new file, wait for content to render and then scroll to the hash exactly once per file+hash
  useEffect(() => {
    if (isSwitching) return; // Still switching, wait until content area is shown
    if (!selectedFileId) return; // Only applies to file views
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash) return;
    const targetId = hash.startsWith("#") ? hash.slice(1) : hash;
    const key = `${selectedFileId}:${targetId}`;
    if (scrolledTargetsRef.current.has(key)) return; // Already scrolled for this target on this file

    let attempts = 0;
    const maxAttempts = 60; // up to ~3s at 50ms
    const tryScroll = () => {
      const el = document.getElementById(targetId);
      if (el) {
        preciseScrollTo(el);
        scrolledTargetsRef.current.add(key);
        return;
      }
      if (attempts++ < maxAttempts) {
        setTimeout(tryScroll, 50);
      }
    };
    tryScroll();
  }, [isSwitching, selectedFileId, preciseScrollTo]);

  // Briefly show a loading skeleton when switching files/artifacts
  useEffect(() => {
    if (!isSwitching) return;
    const timeout = setTimeout(() => setIsSwitching(false), 150);
    return () => clearTimeout(timeout);
  }, [isSwitching]);

  if (isLoading) {
    return <Spinner />;
  }

  const submission = submissionData;

  if (!submission) {
    return <NotFound />;
  }

  return (
    <>
      <Flex pt={{ base: "sm", md: "0" }} gap={{ base: "0", md: "6" }} direction={{ base: "column" }}>
        <Box w={"100%"} minW={"100%"}>
          <FilePicker curFile={filePickerDisplayIndex} onSelect={handleSelectFile} />
          {submission.submission_artifacts && submission.submission_artifacts.length > 0 && (
            <ArtifactPicker curArtifact={artifactPickerDisplayIndex} onSelect={handleSelectArtifact} />
          )}
        </Box>
        <Separator orientation={{ base: "horizontal", md: "vertical" }} />
        <Box w={"100%"}>
          {isSwitching ? (
            <Skeleton height="70vh" width="100%" />
          ) : selectedArtifact && selectedArtifactId !== null ? (
            <Box data-artifact-id={selectedArtifact.id} scrollMarginTop="80px">
              {selectedArtifact.data !== null ? (
                <ArtifactWithComments
                  key={selectedArtifact.id}
                  artifact={selectedArtifact as SubmissionArtifact}
                  reviewAssignmentId={activeReviewAssignmentId}
                  submissionReviewId={finalActiveSubmissionReviewId}
                />
              ) : (
                <ArtifactView key={selectedArtifact.id} artifact={selectedArtifact as SubmissionArtifact} />
              )}
            </Box>
          ) : selectedFile ? (
            <Box data-file-id={selectedFile.id} scrollMarginTop="80px">
              <CodeFile key={selectedFile.id} file={selectedFile} />
            </Box>
          ) : (
            <Text>Select a file or artifact to view.</Text>
          )}
        </Box>
      </Flex>
    </>
  );
}
