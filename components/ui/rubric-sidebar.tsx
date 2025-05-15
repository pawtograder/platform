"use client";
import { Button } from "@/components/ui/button";
import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart,
  RubricChecks,
  RubricCriteriaWithRubricChecks,
  SubmissionArtifactComment,
  SubmissionComments,
  SubmissionFileComment,
  SubmissionReview
} from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Menu, Portal, RadioGroup, Text, VStack, Skeleton, Tag } from "@chakra-ui/react";

import { linkToSubPage } from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/utils";
import { Checkbox } from "@/components/ui/checkbox";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import { Radio } from "@/components/ui/radio";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import {
  useRubricCheckInstances,
  useRubricCriteriaInstances,
  useSubmissionMaybe,
  useReviewAssignment,
  useSubmissionReviewByAssignmentId,
  useReferencedRubricCheckInstances
} from "@/hooks/useSubmission";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { Icon } from "@chakra-ui/react";
import { useCreate, useUpdate } from "@refinedev/core";
import { format, formatRelative } from "date-fns";
import { usePathname } from "next/navigation";
import path from "path";
import { useEffect, useRef, useState } from "react";
import { BsThreeDots, BsFileEarmarkCodeFill, BsFileEarmarkImageFill } from "react-icons/bs";
import { FaCheckCircle, FaTimesCircle } from "react-icons/fa";
import { toaster } from "./toaster";
import PersonAvatar from "./person-avatar";
import { Tooltip } from "./tooltip";
export function CommentActions({
  comment,
  setIsEditing
}: {
  comment: SubmissionFileComment | SubmissionComments | SubmissionArtifactComment;
  setIsEditing: (isEditing: boolean) => void;
}) {
  const { private_profile_id } = useClassProfiles();
  const { mutateAsync: updateComment } = useUpdate({
    resource: isArtifactComment(comment)
      ? "submission_artifact_comments"
      : isLineComment(comment)
        ? "submission_file_comments"
        : "submission_comments"
  });
  return (
    <Menu.Root
      onSelect={async (value) => {
        if (value.value === "edit") {
          setIsEditing(true);
        } else if (value.value === "delete") {
          await updateComment({
            id: comment.id,
            values: {
              edited_by: private_profile_id,
              deleted_at: new Date()
            }
          });
        }
      }}
    >
      <Menu.Trigger asChild>
        <Button p={0} m={0} colorPalette="blue" variant="ghost" size="2xs">
          <Icon as={BsThreeDots} />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content>
            <Menu.Item value="edit">Edit</Menu.Item>
            <Menu.Item value="delete">Delete</Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export function isLineComment(comment: SubmissionFileComment | SubmissionComments): comment is SubmissionFileComment {
  return "line" in comment;
}

export function isArtifactComment(
  comment: SubmissionFileComment | SubmissionComments
): comment is SubmissionArtifactComment {
  return "submission_artifact_id" in comment;
}

export function SubmissionArtifactCommentLink({ comment }: { comment: SubmissionArtifactComment }) {
  const submission = useSubmissionMaybe();
  const pathname = usePathname();
  const artifact = submission?.submission_artifacts.find((artifact) => artifact.id === comment.submission_artifact_id);
  if (!artifact || !submission) {
    return <></>;
  }
  const shortFileName = path.basename(artifact.name);
  return (
    <Link href={linkToSubPage(pathname, "files") + `?artifact_id=${comment.submission_artifact_id}`}>
      @ {shortFileName}
    </Link>
  );
}

export function SubmissionFileCommentLink({ comment }: { comment: SubmissionFileComment }) {
  const submission = useSubmissionMaybe();
  const pathname = usePathname();
  const file = submission?.submission_files.find((file) => file.id === comment.submission_file_id);
  if (!file || !submission) {
    return <></>;
  }
  const shortFileName = path.basename(file.name);
  return (
    <Link href={linkToSubPage(pathname, "files") + `?file_id=${comment.submission_file_id}#L${comment.line}`}>
      @ {shortFileName}:{comment.line}
    </Link>
  );
}

export function RubricCheckComment({
  comment,
  criteria,
  check
}: {
  comment: SubmissionFileComment | SubmissionComments | SubmissionArtifactComment;
  criteria: HydratedRubricCriteria;
  check: HydratedRubricCheck;
}) {
  const author = useUserProfile(comment.author);
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const { mutateAsync: updateComment } = useUpdate({
    resource: isArtifactComment(comment)
      ? "submission_artifact_comments"
      : isLineComment(comment)
        ? "submission_file_comments"
        : "submission_comments"
  });
  const submission = useSubmissionMaybe();
  const pathname = usePathname();

  const linkedFileId =
    check.file && submission ? submission.submission_files.find((f) => f.name === check.file)?.id : undefined;
  const linkedArtifactId =
    check.artifact && submission
      ? submission.submission_artifacts.find((a) => a.name === check.artifact)?.id
      : undefined;

  return (
    <Box border="1px solid" borderColor="border.info" borderRadius="md" p={0} w="100%" fontSize="sm">
      <Box bg="bg.info" pl={1} borderTopRadius="md">
        <HStack justify="space-between">
          <Text fontSize="sm" color="fg.muted">
            {author?.name} applied {formatRelative(comment.created_at, new Date())}
          </Text>
          <CommentActions comment={comment} setIsEditing={setIsEditing} />
        </HStack>
      </Box>
      <Box pl={1} pr={1} color="fg.muted">
        <HStack gap={1}>
          {criteria.is_additive ? (
            <>
              <Icon as={FaCheckCircle} color="green.500" />+{comment.points}
            </>
          ) : (
            <>
              <Icon as={FaTimesCircle} color="red.500" />-{comment.points}
            </>
          )}{" "}
          {isLineComment(comment) && <SubmissionFileCommentLink comment={comment} />}{" "}
          {isArtifactComment(comment) && <SubmissionArtifactCommentLink comment={comment} />}
          {!isLineComment(comment) && !isArtifactComment(comment) && linkedFileId && submission && check.file && (
            <Link href={linkToSubPage(pathname, "files") + `?file_id=${linkedFileId}`}> (Ref: {check.file})</Link>
          )}
          {!isLineComment(comment) &&
            !isArtifactComment(comment) &&
            linkedArtifactId &&
            submission &&
            check.artifact && (
              <Link href={linkToSubPage(pathname, "files") + `?artifact_id=${linkedArtifactId}`}>
                {" "}
                (Ref: {check.artifact})
              </Link>
            )}
        </HStack>
        {isEditing ? (
          <MessageInput
            textAreaRef={messageInputRef}
            defaultSingleLine={true}
            value={comment.comment}
            closeButtonText="Cancel"
            onClose={() => {
              setIsEditing(false);
            }}
            sendButtonText="Save"
            sendMessage={async (message) => {
              await updateComment({
                id: comment.id,
                values: { comment: message }
              });
              setIsEditing(false);
            }}
          />
        ) : (
          <Markdown>{comment.comment}</Markdown>
        )}
      </Box>
    </Box>
  );
}

// New component to display referenced feedback
function ReferencedFeedbackDisplay({ referencing_check_id }: { referencing_check_id: number }) {
  const submission = useSubmissionMaybe();
  const submission_id = submission?.id;

  const { instances, isLoading, error } = useReferencedRubricCheckInstances(referencing_check_id, submission_id);

  if (isLoading) {
    return (
      <Text fontSize="xs" color="fg.muted" mt={2}>
        Loading related feedback...
      </Text>
    );
  }

  if (error) {
    return (
      <Text fontSize="xs" color="red.500" mt={2}>
        Error loading related feedback: {error.message}
      </Text>
    );
  }

  if (!instances || instances.length === 0) {
    return null;
  }

  return (
    <Box mt={3} p={2} borderTop="1px dashed" borderColor="border.subtle" bg="bg.subtle">
      <Text fontWeight="bold" fontSize="sm" mb={2} color="fg.default">
        Related Feedback from Other Reviews:
      </Text>
      <VStack gap={3} alignItems="stretch">
        {instances.map((instance, index) => (
          <Box key={index} p={2} borderWidth="1px" borderRadius="md" borderColor="border.default" bg="bg.canvas">
            <HStack justifyContent="space-between" alignItems="center" mb={1.5}>
              <Tooltip content={instance.referencedRubricCheck.description || "No description"} showArrow>
                <Text fontSize="xs" fontWeight="bold" truncate>
                  {instance.referencedRubricCheck.name}
                </Text>
              </Tooltip>
              {instance.reviewRound && instance.rubric && (
                <Tag.Root size="sm" colorPalette="blue" variant="outline">
                  <Tag.Label>
                    {instance.rubric.name} ({instance.reviewRound})
                  </Tag.Label>
                </Tag.Root>
              )}
            </HStack>
            {instance.authorProfile && (
              <HStack gap={1.5} alignItems="center" mb={1.5}>
                <PersonAvatar uid={instance.authorProfile.id!} size="2xs" />
                <Text fontSize="xs" color="fg.muted">
                  {instance.authorProfile.name || instance.authorProfile.short_name || "Unknown Author"}
                  {instance.comment.points != null &&
                    ` (${instance.comment.points > 0 ? "+" : ""}${instance.comment.points} pts)`}
                </Text>
              </HStack>
            )}
            <Box fontSize="sm">
              <Markdown style={{ fontSize: "0.8rem" }}>{instance.comment.comment}</Markdown>
            </Box>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}

export function RubricCheckAnnotation({
  check,
  criteria,
  activeSubmissionReviewId
}: {
  check: HydratedRubricCheck;
  criteria: HydratedRubricCriteria;
  activeSubmissionReviewId?: number;
}) {
  const rubricCheckComments = useRubricCheckInstances(check as RubricChecks, activeSubmissionReviewId);
  const isGrader = useIsGraderOrInstructor();
  const gradingIsRequired = isGrader && check.is_required && rubricCheckComments.length == 0;
  const annotationTarget = check.annotation_target || "file";

  return (
    <Box
      border="1px solid"
      borderColor={gradingIsRequired ? "border.error" : "border.emphasized"}
      borderRadius="md"
      p={1}
      w="100%"
    >
      <HStack>
        <Tooltip
          content={`This check is an annotation, it can only be applied by ${
            annotationTarget === "file" || annotationTarget === null
              ? "clicking on a specific line of code"
              : "clicking on an artifact"
          }`}
        >
          <Icon as={annotationTarget === "file" ? BsFileEarmarkCodeFill : BsFileEarmarkImageFill} size="xs" />
        </Tooltip>
        <Text>{check.name}</Text>
      </HStack>
      <Markdown
        style={{
          fontSize: "0.8rem"
        }}
      >
        {check.description}
      </Markdown>
      {rubricCheckComments.map((comment) => (
        <RubricCheckComment key={comment.id} comment={comment} criteria={criteria} check={check} />
      ))}
      <ReferencedFeedbackDisplay referencing_check_id={check.id} />
    </Box>
  );
}

export function RubricCheckGlobal({
  check,
  criteria,
  isSelected,
  activeSubmissionReviewId,
  submissionReview
}: {
  check: HydratedRubricCheck;
  criteria: HydratedRubricCriteria;
  isSelected: boolean;
  activeSubmissionReviewId?: number;
  submissionReview?: SubmissionReview;
}) {
  const rubricCheckComments = useRubricCheckInstances(check as RubricChecks, activeSubmissionReviewId);
  const criteriaCheckComments = useRubricCriteriaInstances({
    criteria: criteria as RubricCriteriaWithRubricChecks,
    review_id: activeSubmissionReviewId
  });
  const [selected, setSelected] = useState<boolean>(rubricCheckComments.length > 0);
  const [isEditing, setIsEditing] = useState<boolean>(isSelected && rubricCheckComments.length === 0);
  const submission = useSubmissionMaybe();
  const isGrader = useIsGraderOrInstructor();
  const pathname = usePathname();
  const linkedAritfactId = check.artifact
    ? submission?.submission_artifacts.find((artifact) => artifact.name === check.artifact)?.id
    : undefined;
  const linkedFileId = check.file
    ? submission?.submission_files.find((file) => file.name === check.file)?.id
    : undefined;

  useEffect(() => {
    setSelected(rubricCheckComments.length > 0);
  }, [rubricCheckComments.length]);
  useEffect(() => {
    setIsEditing(
      isSelected &&
        rubricCheckComments.length === 0 &&
        criteria.max_checks_per_submission != criteriaCheckComments.length
    );
  }, [isSelected, rubricCheckComments.length, criteria.max_checks_per_submission, criteriaCheckComments.length]);

  const points = criteria.is_additive ? `+${check.points}` : `-${check.points}`;
  const format = criteria.max_checks_per_submission != 1 ? "checkbox" : "radio";
  const hasOptions = check.data?.options && check.data.options.length > 0;
  const showOptions = isGrader && hasOptions;
  const _selectedOptionIndex =
    hasOptions && rubricCheckComments.length == 1
      ? check.data!.options.findIndex((option) => option.points === rubricCheckComments[0].points)
      : undefined;
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number | undefined>(_selectedOptionIndex);
  const gradingIsRequired = submissionReview && check.is_required && rubricCheckComments.length == 0;
  const gradingIsPermitted =
    isGrader &&
    submissionReview &&
    (criteria.max_checks_per_submission === null ||
      criteriaCheckComments.length < (criteria.max_checks_per_submission || 1000));
  return (
    <Box position="relative" width="100%">
      <HStack>
        {showOptions && (
          <VStack
            align="flex-start"
            w="100%"
            gap={0}
            borderColor={gradingIsRequired ? "border.error" : "border.emphasized"}
            borderWidth={gradingIsRequired ? "1px" : "0px"}
            borderRadius="md"
            p={1}
            wordBreak="break-all"
          >
            <Text fontSize="sm">{check.name}</Text>
            {linkedFileId && submission && (
              <Link href={linkToSubPage(pathname, "files") + `?file_id=${linkedFileId}`}>File: {check.file}</Link>
            )}
            {linkedAritfactId && submission && (
              <Link href={linkToSubPage(pathname, "files") + `?artifact_id=${linkedAritfactId}`}>
                Artifact: {check.artifact}
              </Link>
            )}
            {gradingIsRequired && (
              <Text fontSize="xs" color="fg.error">
                Select one:
              </Text>
            )}
            <RadioGroup.Root
              w="100%"
              value={selectedOptionIndex?.toString()}
              onValueChange={(value) => {
                const selectedOption = check.data!.options[parseInt(value.value)];
                if (selectedOption) {
                  setSelectedOptionIndex(parseInt(value.value));
                  if (gradingIsPermitted) {
                    setIsEditing(true);
                  }
                }
              }}
            >
              {check.data!.options.map((option, index) => (
                <Radio
                  disabled={rubricCheckComments.length > 0 || !submissionReview || !gradingIsPermitted}
                  key={option.label + "-" + index}
                  value={index.toString()}
                >
                  {criteria.is_additive ? "+" : "-"}
                  {option.points} {option.label}
                </Radio>
              ))}
            </RadioGroup.Root>
          </VStack>
        )}
        {!hasOptions && format == "checkbox" && (
          <Checkbox
            disabled={rubricCheckComments.length > 0 || !submissionReview || !gradingIsPermitted}
            checked={selected}
            onCheckedChange={(newState) => {
              if (newState.checked) {
                setIsEditing(true);
              } else {
                setIsEditing(false);
              }
              setSelected(newState.checked ? true : false);
            }}
          >
            <Text>
              {points} {check.name}
            </Text>
            {linkedFileId && submission && (
              <Link
                href={`/course/${submission.class_id}/assignments/${submission.assignment_id}/submissions/${submission.id}/files/?file_id=${linkedFileId}`}
              >
                File: {check.file}
              </Link>
            )}
            {linkedAritfactId && submission && (
              <Link
                href={`/course/${submission.class_id}/assignments/${submission.assignment_id}/submissions/${submission.id}/files/?artifact_id=${linkedAritfactId}`}
              >
                Artifact: {check.artifact}
              </Link>
            )}
          </Checkbox>
        )}
        {!hasOptions && format == "radio" && (
          <Radio value={check.id.toString()} disabled={rubricCheckComments.length > 0 || !submissionReview}>
            <Text>
              {points} {check.name}
              {linkedFileId && submission && (
                <Link href={linkToSubPage(pathname, "files") + `?file_id=${linkedFileId}`}> (File: {check.file})</Link>
              )}
              {linkedAritfactId && submission && (
                <Link href={linkToSubPage(pathname, "files") + `?artifact_id=${linkedAritfactId}`}>
                  {" "}
                  (Artifact: {check.artifact})
                </Link>
              )}
            </Text>
          </Radio>
        )}
      </HStack>
      <Markdown
        style={{
          fontSize: "0.8rem"
        }}
      >
        {check.description}
      </Markdown>
      {isEditing && (
        <SubmissionCommentForm
          check={check}
          selectedOptionIndex={selectedOptionIndex}
          linkedArtifactId={linkedAritfactId}
          activeSubmissionReviewId={activeSubmissionReviewId}
          submissionReview={submissionReview}
        />
      )}
      {rubricCheckComments.map((comment) => (
        <RubricCheckComment key={comment.id} comment={comment} criteria={criteria} check={check} />
      ))}
      <ReferencedFeedbackDisplay referencing_check_id={check.id} />
    </Box>
  );
}

function SubmissionCommentForm({
  check,
  selectedOptionIndex,
  linkedArtifactId,
  activeSubmissionReviewId,
  submissionReview
}: {
  check: HydratedRubricCheck;
  selectedOptionIndex?: number;
  linkedArtifactId?: number;
  activeSubmissionReviewId?: number;
  submissionReview?: SubmissionReview;
}) {
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const submission = useSubmissionMaybe();
  const { mutateAsync: createComment } = useCreate({
    resource:
      check.is_annotation && check.annotation_target === "artifact"
        ? "submission_artifact_comments"
        : check.is_annotation
          ? "submission_file_comments"
          : "submission_comments"
  });

  useEffect(() => {
    if (messageInputRef.current) {
      messageInputRef.current.focus();
    }
  }, []);

  if (!submission) {
    return <></>;
  }

  const selectedOption = selectedOptionIndex !== undefined ? check.data!.options[selectedOptionIndex] : undefined;
  return (
    <Box border="1px solid" borderColor="border.inverted" borderRadius="md" p={0} w="100%" fontSize="sm">
      <Box bg="bg.inverted" pl={1} borderTopRadius="md">
        <Text color="fg.inverted">
          Check not yet applied.{" "}
          {check.is_comment_required ? "A comment is required." : "Comment is optional, enter to add."}
        </Text>
      </Box>
      <MessageInput
        placeholder={"Comment"}
        sendButtonText="Add Check"
        sendMessage={async (message, profile_id) => {
          let comment = message || "";
          if (selectedOptionIndex !== undefined) {
            comment = selectedOption?.label + "\n" + comment;
          }
          const artifactInfo = check.artifact
            ? {
                submission_artifact_id: linkedArtifactId
              }
            : {};

          if (!activeSubmissionReviewId) {
            toaster.error({
              title: "Error saving comment",
              description: "Submission review ID is missing, cannot save comment for check."
            });
            return;
          }

          const values = {
            comment,
            rubric_check_id: check.id,
            class_id: submission.class_id,
            submission_id: submission.id,
            author: profile_id,
            points: selectedOption?.points !== undefined ? selectedOption.points : check.points,
            released: submissionReview?.released,
            submission_review_id: activeSubmissionReviewId,
            ...artifactInfo
          };
          await createComment({ values });
        }}
        defaultSingleLine={true}
        allowEmptyMessage={!check.is_comment_required}
      />
    </Box>
  );
}

function RubricCheck({
  criteria,
  check,
  isSelected,
  activeSubmissionReviewId,
  submissionReview
}: {
  criteria: HydratedRubricCriteria;
  check: HydratedRubricCheck;
  isSelected: boolean;
  activeSubmissionReviewId?: number;
  submissionReview?: SubmissionReview;
}) {
  return (
    <Box p={1} w="100%">
      {check.is_annotation ? (
        <RubricCheckAnnotation check={check} criteria={criteria} activeSubmissionReviewId={activeSubmissionReviewId} />
      ) : (
        <RubricCheckGlobal
          check={check}
          criteria={criteria}
          isSelected={isSelected}
          activeSubmissionReviewId={activeSubmissionReviewId}
          submissionReview={submissionReview}
        />
      )}
    </Box>
  );
}

export function RubricCriteria({
  criteria,
  activeSubmissionReviewId,
  submissionReview
}: {
  criteria: HydratedRubricCriteria;
  activeSubmissionReviewId?: number;
  submissionReview?: SubmissionReview;
}) {
  const comments = useRubricCriteriaInstances({
    criteria: criteria as RubricCriteriaWithRubricChecks,
    review_id: activeSubmissionReviewId
  });
  const totalPoints = comments.reduce((acc, comment) => acc + (comment.points || 0), 0);
  const isAdditive = criteria.is_additive;
  const [selectedCheck, setSelectedCheck] = useState<HydratedRubricCheck>();
  let pointsText = "";
  if (isAdditive) {
    pointsText = `${totalPoints}/${criteria.total_points}`;
  } else {
    pointsText = `${criteria.total_points - totalPoints}/${criteria.total_points}`;
  }
  const isGrader = useIsGraderOrInstructor();
  const gradingIsRequired =
    isGrader &&
    submissionReview &&
    activeSubmissionReviewId &&
    comments.length < (criteria.min_checks_per_submission || 0);
  let instructions = "";
  if (criteria.min_checks_per_submission) {
    if (criteria.max_checks_per_submission) {
      if (criteria.min_checks_per_submission === criteria.max_checks_per_submission) {
        instructions = `Select ${criteria.min_checks_per_submission} check${criteria.min_checks_per_submission === 1 ? "" : "s"}`;
      } else {
        instructions = `Select ${criteria.min_checks_per_submission} - ${criteria.max_checks_per_submission} checks`;
      }
    } else {
      instructions = `Select at least ${criteria.min_checks_per_submission} checks`;
    }
  } else if (criteria.max_checks_per_submission) {
    instructions = `Select at most ${criteria.max_checks_per_submission} checks`;
  }
  const singleCheck =
    criteria.max_checks_per_submission === 1 && comments.length === 1
      ? comments[0].rubric_check_id?.toString()
      : undefined;
  return (
    <Box
      border="1px solid"
      borderColor={gradingIsRequired ? "border.error" : "border.muted"}
      borderRadius="md"
      p={2}
      w="100%"
    >
      <Heading size="sm">
        {criteria.name} {pointsText}
      </Heading>
      <Markdown
        style={{
          fontSize: "0.8rem"
        }}
      >
        {criteria.description}
      </Markdown>
      <VStack align="flex-start" w="100%" gap={0}>
        <Heading size="sm">Checks</Heading>
        <Text fontSize="sm" color={gradingIsRequired ? "fg.error" : "fg.muted"}>
          {instructions}
        </Text>
        <RadioGroup.Root
          w="100%"
          value={singleCheck}
          onValueChange={(value) => {
            setSelectedCheck(criteria.rubric_checks.find((check) => check.id.toString() === value.value));
          }}
        >
          {criteria.rubric_checks.map((check, index) => (
            <RubricCheck
              key={`check-${check.id}-${index}`}
              criteria={criteria}
              check={check}
              isSelected={selectedCheck?.id === check.id}
              activeSubmissionReviewId={activeSubmissionReviewId}
              submissionReview={submissionReview}
            />
          ))}
        </RadioGroup.Root>
      </VStack>
    </Box>
  );
}

export function RubricPart({
  part,
  activeSubmissionReviewId,
  submissionReview
}: {
  part: HydratedRubricPart;
  activeSubmissionReviewId?: number;
  submissionReview?: SubmissionReview;
}) {
  return (
    <Box>
      <Heading size="md">{part.name}</Heading>
      <Markdown>{part.description}</Markdown>
      <VStack align="start" w="100%">
        {part.rubric_criteria
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((criteria, index) => (
            <RubricCriteria
              key={`criteria-${criteria.id}-${index}`}
              criteria={criteria}
              activeSubmissionReviewId={activeSubmissionReviewId}
              submissionReview={submissionReview}
            />
          ))}
      </VStack>
    </Box>
  );
}

export default function RubricSidebar({
  initialRubric,
  reviewAssignmentId
}: {
  initialRubric?:
    | HydratedRubric
    | import("@/utils/supabase/SupabaseTypes").Database["public"]["Tables"]["rubrics"]["Row"];
  reviewAssignmentId?: number;
}) {
  const {
    reviewAssignment,
    isLoading: isLoadingReviewAssignment,
    error: reviewAssignmentError
  } = useReviewAssignment(reviewAssignmentId);

  const {
    submissionReview,
    isLoading: isLoadingSubmissionReview,
    error: submissionReviewError
  } = useSubmissionReviewByAssignmentId(reviewAssignmentId);

  const submission = useSubmissionMaybe();

  let displayRubric: HydratedRubric | undefined | null = null;
  if (reviewAssignmentId && reviewAssignment?.rubrics) {
    const fetchedReviewRubric = reviewAssignment.rubrics;
    displayRubric = {
      ...fetchedReviewRubric,
      rubric_parts: fetchedReviewRubric.rubric_parts || []
    } as unknown as HydratedRubric;
  } else if (initialRubric) {
    displayRubric = {
      ...initialRubric,
      rubric_parts: (initialRubric as HydratedRubric).rubric_parts || []
    } as unknown as HydratedRubric;
  } else if (submission?.assignments?.rubrics) {
    const defaultAssignmentRubric = submission.assignments.rubrics;
    displayRubric = {
      ...defaultAssignmentRubric,
      rubric_parts: []
    } as unknown as HydratedRubric;
  }

  let partsToDisplay: HydratedRubricPart[] = [];
  if (displayRubric) {
    if (
      reviewAssignmentId &&
      reviewAssignment?.review_assignment_rubric_parts &&
      reviewAssignment.review_assignment_rubric_parts.length > 0
    ) {
      partsToDisplay = reviewAssignment.review_assignment_rubric_parts
        .map((linkedPart) => linkedPart.rubric_parts as HydratedRubricPart)
        .filter((part): part is HydratedRubricPart => !!part)
        .sort((a, b) => (a?.ordinal ?? 0) - (b?.ordinal ?? 0));
    } else if (displayRubric.rubric_parts) {
      partsToDisplay = [...displayRubric.rubric_parts].sort((a, b) => a.ordinal - b.ordinal);
    } else {
      partsToDisplay = [];
    }
  }

  const isLoading = (isLoadingReviewAssignment || isLoadingSubmissionReview) && reviewAssignmentId;

  if (isLoading) {
    return (
      <Box p={2} minW="md" maxW="lg">
        <Skeleton height="100vh" />
      </Box>
    );
  }

  if (reviewAssignmentError || submissionReviewError) {
    return (
      <Box p={2}>
        <Text color="red.500">
          Error loading review details: {reviewAssignmentError?.message || submissionReviewError?.message}
        </Text>
      </Box>
    );
  }

  if (!displayRubric) {
    return (
      <Box p={2} minW="md" maxW="lg">
        <Text>No rubric information available.</Text>
      </Box>
    );
  }

  return (
    <Box
      borderLeftWidth="1px"
      borderColor="border.emphasized"
      p={2}
      ml={0}
      minW="md"
      maxW="lg"
      height="100vh"
      overflowY="auto"
      overflowX="hidden"
    >
      <VStack align="start" w="100%">
        <Heading size="xl">Grading Rubric</Heading>
        {reviewAssignment && (
          <Box fontSize="sm" color="text.muted" mb={2}>
            {reviewAssignment.due_date && (
              <Text>Due: {format(new Date(reviewAssignment.due_date), "MMM d, yyyy 'at' h:mm a")}</Text>
            )}
            {reviewAssignment.release_date && (
              <Text>Grades Release: {format(new Date(reviewAssignment.release_date), "MMM d, yyyy 'at' h:mm a")}</Text>
            )}
          </Box>
        )}
        {partsToDisplay.map((part) => (
          <RubricPart
            key={part.name + "-" + part.id}
            part={part}
            activeSubmissionReviewId={submissionReview?.id}
            submissionReview={submissionReview}
          />
        ))}
      </VStack>
    </Box>
  );
}
