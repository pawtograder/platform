"use client";

import { Checkbox } from "@/components/ui/checkbox";
import CodeFile, {
  formatPoints,
  RubricCheckSelectOption,
  RubricCheckSubOptions,
  RubricCriteriaSelectGroupOption,
  type CodeFileHandle
} from "@/components/ui/code-file";
import { FileTreeSidebar, ancestorFolderPaths, buildFileTree, flattenVisibleTree } from "@/components/ui/file-tree";
import DownloadLink from "@/components/ui/download-link";
import { GroupMemberSelectOption } from "@/components/ui/group-member-select-option";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import MarkdownFilePreview, { isMarkdownFile } from "@/components/ui/markdown-file-preview";
import BinaryFilePreview from "@/components/ui/binary-file-preview";
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
  useRubricParts,
  useRubricWithParts
} from "@/hooks/useAssignment";
import { useIsGrader, useIsGraderOrInstructor, useIsInstructor } from "@/hooks/useClassProfiles";
import { useAssignmentGroupWithMembers, useCourseController } from "@/hooks/useCourseController";
import {
  computeRubricAnnotationTargetMetaFromParts,
  effectiveAnnotationTargetStudentProfileId
} from "@/hooks/useRubricAnnotationTargetMeta";
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
import { useStableDesktop } from "@/hooks/useStableDesktop";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
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
  NativeSelectField,
  NativeSelectRoot,
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
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FaCheckCircle, FaColumns, FaDownload, FaEyeSlash, FaTimes, FaTimesCircle } from "react-icons/fa";
import { Group, Panel, Separator as PanelSeparator } from "react-resizable-panels";

// Module-stable style — `<Markdown>` is `memo`-wrapped (see
// `components/ui/markdown.tsx`); inline literals defeat the memo.
const RUBRIC_CHECK_DESCRIPTION_STYLE: CSSProperties = { fontSize: "0.8rem" };

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
            <Markdown style={RUBRIC_CHECK_DESCRIPTION_STYLE}>{rubricCheck.description}</Markdown>
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
              <Text data-visual-test="transparent" data-visual-placeholder="timestamp">
                commented on {format(comment.created_at, "MMM d, yyyy")}
              </Text>
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
  const fallbackGradingReviewId = submission.grading_review_id;
  if (!fallbackGradingReviewId) {
    throw new Error("No grading review ID found");
  }
  const effectiveSubmissionReviewId = submissionReviewId ?? fallbackGradingReviewId;
  const reviewContext = useSubmissionReviewOrGradingReview(effectiveSubmissionReviewId);
  const finalSubmissionReviewId = reviewContext?.id ?? effectiveSubmissionReviewId;
  const releasedForWrite = finalSubmissionReviewId === reviewContext?.id ? Boolean(reviewContext?.released) : true;
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const isInstructor = useIsInstructor();
  const isTaOnly = useIsGrader();
  const [eventuallyVisible, setEventuallyVisible] = useState(true);
  const submissionController = useSubmissionController();

  const postComment = useCallback(
    async (message: string, author_id: string) => {
      try {
        await submissionController.submission_artifact_comments.create({
          submission_id: submission.id,
          submission_artifact_id: artifact.id,
          class_id: submission.class_id,
          author: author_id,
          comment: message,
          submission_review_id: finalSubmissionReviewId,
          released: releasedForWrite,
          eventually_visible: eventuallyVisible,
          rubric_check_id: null,
          points: null,
          regrade_request_id: null
        });
      } catch (error: unknown) {
        toaster.error({
          title: "Could not save comment",
          description: getStudentFacingErrorMessage(error, {
            releasedReviewGraderBlocked: isGraderOrInstructor && !isInstructor && isTaOnly && releasedForWrite
          })
        });
        throw error;
      }
    },
    [
      submissionController,
      submission,
      artifact,
      releasedForWrite,
      eventuallyVisible,
      finalSubmissionReviewId,
      isGraderOrInstructor,
      isInstructor,
      isTaOnly
    ]
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
  const fallbackGradingReviewId = submission.grading_review_id;
  if (!fallbackGradingReviewId) {
    throw new Error("No grading review ID found");
  }
  const effectiveSubmissionReviewId = submissionReviewId ?? fallbackGradingReviewId;
  const reviewContext = useSubmissionReviewOrGradingReview(effectiveSubmissionReviewId);
  const finalSubmissionReviewId = reviewContext?.id ?? effectiveSubmissionReviewId;
  const releasedForWrite = finalSubmissionReviewId === reviewContext?.id ? Boolean(reviewContext?.released) : true;
  const isInstructor = useIsInstructor();
  const isTaOnly = useIsGrader();
  const rubric = useRubricWithParts(reviewContext?.rubric_id);
  const rubricCriteria = useRubricCriteriaByRubric(rubric?.id);
  const rubricChecks = useRubricChecksByRubric(rubric?.id);
  const rubricParts = useRubricParts(reviewContext?.rubric_id ?? null);
  const assignmentGroupWithMembers = useAssignmentGroupWithMembers({
    assignment_group_id: submission.assignment_group_id ?? undefined
  });
  const groupMembers = useMemo(
    () => assignmentGroupWithMembers?.assignment_groups_members ?? [],
    [assignmentGroupWithMembers]
  );

  const [selectedCheckOption, setSelectedCheckOption] = useState<RubricCheckSelectOption | null>(null);
  const [selectedSubOption, setSelectedSubOption] = useState<RubricCheckSubOptions | null>(null);
  const submissionController = useSubmissionController();

  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const [eventuallyVisible, setEventuallyVisible] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [pickedArtifactAnnotationStudentId, setPickedArtifactAnnotationStudentId] = useState<string | null>(null);

  const artifactAnnotationTargetMeta = useMemo(
    () =>
      computeRubricAnnotationTargetMetaFromParts({
        criteria: selectedCheckOption?.criteria ?? null,
        parts: rubricParts ?? null,
        members: groupMembers,
        review: reviewContext ?? null
      }),
    [selectedCheckOption?.criteria, rubricParts, groupMembers, reviewContext]
  );

  useEffect(() => {
    setPickedArtifactAnnotationStudentId(null);
  }, [selectedCheckOption?.criteria?.id, selectedCheckOption?.check?.id]);

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
                {selectedCheckOption.check && artifactAnnotationTargetMeta.mode === "individual" && (
                  <NativeSelectRoot size="sm">
                    <NativeSelectField
                      aria-label="Group member this annotation is for"
                      value={pickedArtifactAnnotationStudentId ?? ""}
                      onChange={(e) => setPickedArtifactAnnotationStudentId(e.target.value || null)}
                    >
                      <option value="">Select group member…</option>
                      {artifactAnnotationTargetMeta.members.map((m) => (
                        <GroupMemberSelectOption key={m.profile_id} profileId={m.profile_id} />
                      ))}
                    </NativeSelectField>
                  </NativeSelectRoot>
                )}
                {selectedCheckOption.check && artifactAnnotationTargetMeta.mode === "assign_blocked" && (
                  <Text fontSize="sm" color="fg.error">
                    {artifactAnnotationTargetMeta.reason}
                  </Text>
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

                    if (!finalSubmissionReviewId && selectedCheckOption.check?.id) {
                      toaster.error({
                        title: "Error saving comment",
                        description: "Submission review ID is missing for rubric annotation on artifact."
                      });
                      return;
                    }

                    const targetEff = effectiveAnnotationTargetStudentProfileId(
                      artifactAnnotationTargetMeta,
                      pickedArtifactAnnotationStudentId
                    );
                    if (targetEff.error) {
                      toaster.error({ title: "Cannot save annotation", description: targetEff.error });
                      return;
                    }

                    const values = {
                      comment: commentText,
                      rubric_check_id: selectedCheckOption.check?.id ?? null,
                      class_id: submission.class_id,
                      submission_id: submission.id,
                      submission_artifact_id: artifact.id,
                      author: profile_id,
                      released: releasedForWrite,
                      points: points ?? null,
                      submission_review_id: finalSubmissionReviewId,
                      eventually_visible: eventuallyVisible,
                      regrade_request_id: null,
                      target_student_profile_id: targetEff.targetId
                    };
                    try {
                      await submissionController.submission_artifact_comments.create(values);
                      setIsOpen(false);
                    } catch (error: unknown) {
                      toaster.error({
                        title: "Could not save annotation",
                        description: getStudentFacingErrorMessage(error, {
                          releasedReviewGraderBlocked:
                            isGraderOrInstructor && !isInstructor && isTaOnly && releasedForWrite
                        })
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
  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadArtifact() {
      if (artifact.data.format === "plaintext" || artifact.data.format === "markdown") {
        setTextContent(null);
      }
      const client = createClient();
      if (artifact.data.format === "zip" && artifact.data.display === "html_site") {
        const data = await client.functions.invoke("submission-serve-artifact", {
          body: JSON.stringify({
            classId: artifact.class_id,
            submissionId: artifact.submission_id,
            artifactId: artifact.id
          })
        });
        if (isMounted) setSiteUrl(data.data.url);
      }

      if (artifact.data.format === "png") {
        const { data: urlData, error: urlError } = await client.storage
          .from("submission-artifacts")
          .createSignedUrl(artifactKey, 60 * 60 * 24);
        if (!isMounted) return;
        if (urlError) {
          toaster.error({ title: "Error loading artifact image", description: urlError.message });
          return;
        }
        if (urlData) setSignedUrl(urlData.signedUrl);
      } else if (artifact.data.format === "plaintext" || artifact.data.format === "markdown") {
        const data = await client.storage.from("submission-artifacts").download(artifactKey);
        if (!isMounted) return;
        if (data.data) {
          const text = await data.data.text();
          if (isMounted) setTextContent(text);
        }
        if (data.error) {
          toaster.error({ title: "Error loading artifact: " + data.error, description: "Please try again." });
        }
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

  if (artifact.data.format === "png") {
    if (signedUrl) {
      return (
        //eslint-disable-next-line @next/next/no-img-element
        <img
          src={signedUrl}
          alt={artifact.name}
          loading="lazy"
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
  } else if (artifact.data.format === "plaintext") {
    if (textContent !== null) {
      return (
        <Box
          as="pre"
          p={4}
          overflowX="auto"
          overflowY="auto"
          maxH="70vh"
          borderWidth="1px"
          borderColor="border.emphasized"
          borderRadius="md"
          whiteSpace="pre-wrap"
          wordBreak="break-word"
          fontSize="sm"
        >
          {textContent}
        </Box>
      );
    }
    return <Spinner />;
  } else if (artifact.data.format === "markdown") {
    if (textContent !== null) {
      return (
        <Box
          p={4}
          overflowX="auto"
          overflowY="auto"
          maxH="70vh"
          borderWidth="1px"
          borderColor="border.emphasized"
          borderRadius="md"
        >
          <Markdown>{textContent}</Markdown>
        </Box>
      );
    }
    return <Spinner />;
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
    // `#L<n>` line anchors live inside the code editor, which renders lines virtually — there is no
    // element to getElementById. Use the editor's imperative handle for those; the editor is already
    // mounted here (this path only fires for an already-open file), so a single call suffices.
    const lineMatch = /^L(\d+)$/.exec(id);
    if (lineMatch) {
      codeFileRef.current?.scrollToLine(Number(lineMatch[1]));
      return;
    }
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

  const submissionFiles = useMemo(() => submissionData?.submission_files ?? [], [submissionData]);
  const submissionArtifacts = submissionData?.submission_artifacts ?? [];
  const normalizedSelectedFileId =
    selectedFileId !== null && submissionFiles.some((file: SubmissionFile) => file.id === selectedFileId)
      ? selectedFileId
      : null;
  const normalizedSelectedArtifactId =
    selectedArtifactId !== null &&
    submissionArtifacts.some((artifact: Tables<"submission_artifacts">) => artifact.id === selectedArtifactId)
      ? selectedArtifactId
      : null;

  // Default to a source-code file rather than whatever happens to be first: the embedded
  // submission_files arrive in an unspecified order, and opening a markdown file shows its rendered
  // *preview* (no code lines) — graders want to land on code. Pick deterministically by name so the
  // default is stable across loads, preferring code over markdown/binary, falling back to the
  // name-first file when there is no code file.
  const filesByName = useMemo(
    () => [...submissionFiles].sort((a: SubmissionFile, b: SubmissionFile) => a.name.localeCompare(b.name)),
    [submissionFiles]
  );
  const defaultFileId =
    (filesByName.find((file: SubmissionFile) => !file.is_binary && !isMarkdownFile(file.name)) ?? filesByName[0])?.id ??
    null;
  const defaultArtifactId = submissionArtifacts[0]?.id ?? null;
  // Prefer file when both file_id and artifact_id are valid in the URL — checking
  // artifact first would null out the file and then artifact suppression would null both.
  const effectiveFileId =
    normalizedSelectedFileId !== null
      ? normalizedSelectedFileId
      : normalizedSelectedArtifactId !== null
        ? null
        : defaultFileId !== null
          ? defaultFileId
          : null;
  const effectiveArtifactId =
    normalizedSelectedFileId !== null
      ? null
      : normalizedSelectedArtifactId !== null
        ? normalizedSelectedArtifactId
        : defaultFileId === null && defaultArtifactId !== null
          ? defaultArtifactId
          : null;

  const curFileIndex = submissionFiles.findIndex((file: SubmissionFile) => file.id === (effectiveFileId ?? -1));
  const selectedFile =
    curFileIndex !== -1
      ? submissionFiles[curFileIndex]
      : effectiveFileId !== null && submissionFiles.length > 0
        ? submissionFiles[0]
        : undefined;

  const curArtifactIndex = submissionArtifacts.findIndex(
    (artifact: Tables<"submission_artifacts">) => artifact.id === (effectiveArtifactId ?? -1)
  );
  const selectedArtifact =
    curArtifactIndex !== -1
      ? submissionArtifacts[curArtifactIndex]
      : effectiveArtifactId !== null && submissionArtifacts.length > 0
        ? submissionArtifacts[0]
        : undefined;

  const isLoading = isLoadingSubmission || (!!reviewAssignment && currentSubmissionReview === undefined);

  // Resolve prop types
  const artifactPickerDisplayIndex = curArtifactIndex === -1 ? 0 : curArtifactIndex;
  const finalActiveSubmissionReviewId =
    activeSubmissionReviewIdToUse === null ? undefined : activeSubmissionReviewIdToUse;

  // ───────────────────────── File-tree navigation (#288 / #103a) ─────────────────────────
  // Folder collapse state and a keyboard cursor are owned here (not in FileTreeSidebar) because
  // FilesView holds the canonical ordered file list, the active id, and the selection handlers,
  // and is the only place that also knows about artifacts. The tree stays purely presentational.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const codeFileRef = useRef<CodeFileHandle>(null);
  const allFileComments = useSubmissionFileComments({});

  const onCollapseChange = useCallback((path: string, isCollapsed: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (isCollapsed) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const fileTree = useMemo(() => buildFileTree(submissionFiles), [submissionFiles]);
  const visibleEntries = useMemo(() => flattenVisibleTree(fileTree, collapsed), [fileTree, collapsed]);

  // Auto-expand the folders leading to the active file so it is always visible in the tree.
  // Intentionally keyed on the file name only — re-running on full `selectedFile` identity is unwanted.
  const selectedFileName = selectedFile?.name;
  useEffect(() => {
    if (!selectedFileName) return;
    const ancestors = ancestorFolderPaths(selectedFileName);
    if (ancestors.length === 0) return;
    setCollapsed((prev) => {
      if (ancestors.every((p) => !prev.has(p))) return prev;
      const next = new Set(prev);
      ancestors.forEach((p) => next.delete(p));
      return next;
    });
  }, [selectedFileName]);

  // Sorted, de-duplicated commented line numbers for the active file (for next/prev-comment jumps).
  const commentLines = useMemo(() => {
    const lines = new Set<number>();
    for (const c of allFileComments) {
      if (c.submission_file_id === effectiveFileId && typeof c.line === "number") lines.add(c.line);
    }
    return Array.from(lines).sort((a, b) => a - b);
  }, [allFileComments, effectiveFileId]);
  const lastCommentLineRef = useRef<number | null>(null);

  const gotoComment = useCallback(
    (delta: 1 | -1) => {
      if (commentLines.length === 0) return;
      const cur = lastCommentLineRef.current;
      let next: number;
      if (cur === null) {
        next = delta > 0 ? commentLines[0] : commentLines[commentLines.length - 1];
      } else if (delta > 0) {
        next = commentLines.find((l) => l > cur) ?? commentLines[0];
      } else {
        next = [...commentLines].reverse().find((l) => l < cur) ?? commentLines[commentLines.length - 1];
      }
      lastCommentLineRef.current = next;
      codeFileRef.current?.scrollToLine(next);
    },
    [commentLines]
  );

  // ───────────────────────── Multi-file tabs + split view ─────────────────────────
  // `openFileIds` is the ordered set of files shown as tabs; the active tab is the URL-driven
  // effectiveFileId. `splitFileId` (when set) shows a second editor pane side-by-side.
  const [openFileIds, setOpenFileIds] = useState<number[]>([]);
  const [splitFileId, setSplitFileId] = useState<number | null>(null);
  // Resizable panels are a desktop affordance; on small screens we stack the columns instead.
  // `useStableDesktop` (not raw `useBreakpointValue`) so a full-page screenshot's transient 1px
  // viewport can't flip the layout and remount the editor (which would drop an open annotation popup).
  const isDesktop = useStableDesktop();

  // Opening / activating a file makes it a tab.
  useEffect(() => {
    if (effectiveFileId == null) return;
    setOpenFileIds((prev) => (prev.includes(effectiveFileId) ? prev : [...prev, effectiveFileId]));
  }, [effectiveFileId]);

  const openFiles = useMemo(
    () =>
      openFileIds
        .map((id) => submissionFiles.find((f: SubmissionFile) => f.id === id))
        .filter((f): f is SubmissionFile => !!f),
    [openFileIds, submissionFiles]
  );

  const closeTab = useCallback(
    (id: number) => {
      setOpenFileIds((prev) => {
        const idx = prev.indexOf(id);
        const next = prev.filter((f) => f !== id);
        // If the active tab was closed, activate a neighbouring tab.
        if (id === effectiveFileId && next.length > 0) {
          handleSelectFile(next[Math.min(idx, next.length - 1)]);
        }
        return next;
      });
      setSplitFileId((s) => (s === id ? null : s));
    },
    [effectiveFileId, handleSelectFile]
  );

  const splitFile = useMemo(
    () => (splitFileId != null ? (submissionFiles.find((f: SubmissionFile) => f.id === splitFileId) ?? null) : null),
    [splitFileId, submissionFiles]
  );
  const toggleSplit = useCallback(() => {
    setSplitFileId((s) => (s != null ? null : (effectiveFileId ?? null)));
  }, [effectiveFileId]);
  // ──────────────────────────────────────────────────────────────────────────────

  // Global keyboard navigation for grading. Integrates with the app-wide keyboard infra
  // (hooks/useKeyboardShortcuts): we bail when that handler already acted (`defaultPrevented`, e.g. a
  // `g`-chord, `?` help, or Shift-toggle) and ignore modifier/Shift combos so we never shadow it. We
  // also bail inside editable surfaces, overlays, and interactive controls. Up/Down (or j/k) move
  // between the *visible* files in tree order; n/p (or ]/[) jump between commented lines.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          "textarea, input, select, button, a[href], [contenteditable='true'], .monaco-editor, [data-annotation-popup], [role='dialog'], [role='listbox'], [role='menu'], [role='combobox'], [role='button'], [role='tab'], [role='switch'], [role='checkbox'], [role='textbox']"
        )
      ) {
        return;
      }

      const moveToFile = (delta: 1 | -1) => {
        const files = visibleEntries.filter((entry) => entry.type === "file" && entry.fileId != null);
        if (files.length === 0) return;
        const curIdx = files.findIndex((entry) => entry.fileId === effectiveFileId);
        let idx = curIdx === -1 ? (delta > 0 ? 0 : files.length - 1) : curIdx + delta;
        idx = Math.max(0, Math.min(files.length - 1, idx));
        const nextFile = files[idx];
        if (nextFile?.fileId != null) handleSelectFile(nextFile.fileId);
      };

      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          moveToFile(1);
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          moveToFile(-1);
          break;
        case "n":
        case "]":
          e.preventDefault();
          gotoComment(1);
          break;
        case "p":
        case "[":
          e.preventDefault();
          gotoComment(-1);
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [visibleEntries, effectiveFileId, handleSelectFile, gotoComment]);
  // ──────────────────────────────────────────────────────────────────────────────────────

  // Scroll to line anchors when hash is present and relevant content is rendered
  useEffect(() => {
    scrollToHash();
  }, [effectiveFileId, effectiveArtifactId, scrollToHash]);

  // Scroll to top of file/artifact when navigating via URL params (file_id or artifact_id)
  useEffect(() => {
    if (isSwitching) return; // Wait until content is rendered
    if (typeof window === "undefined") return;

    // Only scroll if there's no hash (hash scrolling is handled separately)
    const hash = window.location.hash;
    if (hash) return;

    // Determine which selector to use based on which ID is set (using !== null to handle 0 correctly)
    const selector =
      effectiveFileId !== null
        ? `[data-file-id="${effectiveFileId}"]`
        : effectiveArtifactId !== null
          ? `[data-artifact-id="${effectiveArtifactId}"]`
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
  }, [isSwitching, effectiveFileId, effectiveArtifactId, getScrollableAncestor]);

  // After switching to a new file, wait for content to render and then scroll to the hash exactly once per file+hash
  useEffect(() => {
    if (isSwitching) return; // Still switching, wait until content area is shown
    if (!effectiveFileId) return; // Only applies to file views
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash) return;
    const targetId = hash.startsWith("#") ? hash.slice(1) : hash;
    const key = `${effectiveFileId}:${targetId}`;
    if (scrolledTargetsRef.current.has(key)) return; // Already scrolled for this target on this file

    // `#L<n>` line anchors don't map to a DOM id — the code editor (Monaco by default) renders lines
    // virtually, so getElementById would never find them. Drive the scroll through the editor's
    // imperative handle instead, retrying until the editor has mounted (scrollToLine returns false
    // until then). Non-line anchors still resolve to a real element.
    const lineMatch = /^L(\d+)$/.exec(targetId);
    const targetLine = lineMatch ? Number(lineMatch[1]) : null;

    let attempts = 0;
    const maxAttempts = 60; // up to ~3s at 50ms
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const tryScroll = () => {
      if (targetLine !== null) {
        if (codeFileRef.current?.scrollToLine(targetLine)) {
          scrolledTargetsRef.current.add(key);
          return;
        }
      } else {
        const el = document.getElementById(targetId);
        if (el) {
          preciseScrollTo(el);
          scrolledTargetsRef.current.add(key);
          return;
        }
      }
      if (attempts++ < maxAttempts) {
        timeoutId = setTimeout(tryScroll, 50);
      }
    };
    tryScroll();
    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [isSwitching, effectiveFileId, preciseScrollTo]);

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

  // Renders the content for a single file (code / markdown / binary). `primary` wires the imperative
  // ref used by next/prev-comment navigation to the main editor pane only.
  const renderFileContent = (file: SubmissionFile, primary: boolean): ReactNode => {
    if (isMarkdownFile(file.name) && !file.is_binary) {
      return (
        <MarkdownFilePreview
          key={file.id}
          file={file}
          allFiles={submission.submission_files}
          onNavigateToFile={handleSelectFile}
        />
      );
    }
    if (file.is_binary) {
      return <BinaryFilePreview key={file.id} file={file} />;
    }
    // Stable key per pane (not per file): keep the Monaco instance mounted across tab switches so it
    // swaps models in place instead of remounting — remounting caused a white flash between files.
    return (
      <CodeFile
        key={primary ? "code-file-primary" : "code-file-split"}
        ref={primary ? codeFileRef : undefined}
        file={file}
        indexFiles={submission.submission_files}
        onNavigateToFile={primary ? handleSelectFile : setSplitFileId}
      />
    );
  };

  // A VS Code-style tab strip over the open files. `extra` renders trailing controls (e.g. close-split).
  const FileTabBar = ({
    activeId,
    onSelect,
    extra
  }: {
    activeId: number | null;
    onSelect: (id: number) => void;
    extra?: ReactNode;
  }) => (
    <Flex
      bg="bg.subtle"
      borderBottom="1px solid"
      borderColor="border.emphasized"
      alignItems="stretch"
      overflowX="auto"
      flexShrink={0}
      aria-label="Open files"
    >
      {openFiles.map((f) => {
        const isActive = f.id === activeId;
        const name = f.name.split("/").pop() || f.name;
        return (
          <Flex
            key={f.id}
            data-tab-file-id={f.id}
            data-active={isActive ? "true" : undefined}
            alignItems="center"
            gap={1}
            px={3}
            py={1.5}
            cursor="pointer"
            minW="fit-content"
            bg={isActive ? "bg.default" : "transparent"}
            borderRight="1px solid"
            borderColor="border.emphasized"
            borderBottom={isActive ? "2px solid" : "2px solid transparent"}
            borderBottomColor={isActive ? "fg.info" : "transparent"}
            onClick={() => onSelect(f.id)}
          >
            <Text fontSize="sm" fontWeight={isActive ? "semibold" : "normal"} lineClamp={1} maxW="180px">
              {name}
            </Text>
            <Icon
              as={FaTimes}
              boxSize={2.5}
              color="fg.muted"
              _hover={{ color: "fg.default" }}
              aria-label={`Close ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(f.id);
              }}
            />
          </Flex>
        );
      })}
      <Box flex="1" />
      {extra}
    </Flex>
  );

  const fileNavigator = (
    <Box
      aria-label="File navigator"
      tabIndex={0}
      h="100%"
      display="flex"
      flexDirection="column"
      minH={0}
      outline="none"
      data-file-navigator=""
    >
      <Box flex="1" minH={0} display="flex">
        {submissionFiles.length > 0 && (
          <FileTreeSidebar
            files={submissionFiles}
            activeFileId={effectiveFileId}
            onFileSelect={handleSelectFile}
            collapsed={collapsed}
            onCollapseChange={onCollapseChange}
          />
        )}
      </Box>
      {submission.submission_artifacts && submission.submission_artifacts.length > 0 && (
        <ArtifactPicker curArtifact={artifactPickerDisplayIndex} onSelect={handleSelectArtifact} />
      )}
    </Box>
  );

  const editorArea = isSwitching ? (
    <Skeleton height="100%" width="100%" />
  ) : selectedArtifact ? (
    <Box data-artifact-id={selectedArtifact.id} h="100%" overflow="auto" scrollMarginTop="80px">
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
    <Group orientation="horizontal" style={{ height: "100%" }}>
      <Panel minSize="25">
        <Flex direction="column" h="100%" minH={0}>
          <FileTabBar
            activeId={effectiveFileId}
            onSelect={handleSelectFile}
            extra={
              <Button
                size="xs"
                variant="ghost"
                aria-label={splitFile ? "Close split view" : "Split editor"}
                title={splitFile ? "Close split view" : "Split editor"}
                onClick={toggleSplit}
                m={1}
              >
                <Icon as={FaColumns} />
              </Button>
            }
          />
          <Box flex="1" minH={0} overflow="auto" data-file-id={selectedFile.id} scrollMarginTop="80px">
            {renderFileContent(selectedFile, true)}
          </Box>
        </Flex>
      </Panel>
      {splitFile && (
        <>
          <PanelSeparator>
            <Box w="6px" h="100%" bg="bg.muted" _hover={{ bg: "border.emphasized" }} cursor="col-resize" />
          </PanelSeparator>
          <Panel minSize="25">
            <Flex direction="column" h="100%" minH={0}>
              <FileTabBar activeId={splitFileId} onSelect={(id) => setSplitFileId(id)} />
              <Box flex="1" minH={0} overflow="auto">
                {renderFileContent(splitFile, false)}
              </Box>
            </Flex>
          </Panel>
        </>
      )}
    </Group>
  ) : (
    <Text>Select a file or artifact to view.</Text>
  );

  // Desktop: resizable tree|code columns inside a fixed-height shell (each pane scrolls internally,
  // so editors fill their pane). Mobile: stack the navigator above the editor and let the page scroll.
  if (!isDesktop) {
    return (
      <Flex direction="column" gap={2}>
        <Box maxH="40vh" overflow="auto" border="1px solid" borderColor="border.emphasized" borderRadius="md">
          {fileNavigator}
        </Box>
        <Separator />
        <Box minH="60vh">{editorArea}</Box>
      </Flex>
    );
  }

  return (
    <Box h="100%" minH={0}>
      <Group orientation="horizontal" style={{ height: "100%" }}>
        <Panel defaultSize="20" minSize="12" maxSize="40">
          {fileNavigator}
        </Panel>
        <PanelSeparator>
          <Box w="6px" h="100%" bg="bg.muted" _hover={{ bg: "border.emphasized" }} cursor="col-resize" />
        </PanelSeparator>
        <Panel minSize="30">
          <Box h="100%" minW={0} minH={0}>
            {editorArea}
          </Box>
        </Panel>
      </Group>
    </Box>
  );
}
