"use client";
import { Button } from "@/components/ui/button";
import {
  HydratedRubricCheck,
  RubricChecks,
  RubricCheck as RubricCheckType,
  RubricCriteria as RubricCriteriaType,
  RubricPart as RubricPartType,
  SubmissionArtifactComment,
  SubmissionComments,
  SubmissionFileComment,
  SubmissionReview
} from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Field,
  Fieldset,
  Heading,
  HStack,
  Menu,
  NativeSelectField,
  NativeSelectRoot,
  Portal,
  RadioGroup,
  Separator,
  Skeleton,
  Spinner,
  Tag,
  Text,
  VStack
} from "@chakra-ui/react";

import { linkToSubPage } from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/utils";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import { Radio } from "@/components/ui/radio";
import { toaster } from "@/components/ui/toaster";
import {
  useAllRubricChecks,
  useAssignmentController,
  useGraderPseudonymousMode,
  useReferenceCheckRecordsFromCheck,
  useReviewAssignment,
  useReviewAssignmentRubricParts,
  useRubricById,
  useRubricCheck,
  useRubricChecksByCriteria,
  useRubricCriteriaByPart,
  useRubricParts,
  useRubrics
} from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor, useIsInstructor, useIsStudent } from "@/hooks/useClassProfiles";
import { useShouldShowRubricCheck } from "@/hooks/useRubricVisibility";
import {
  useReferencedRubricCheckInstances,
  useRubricCheckInstances,
  useRubricCriteriaInstances,
  useSubmissionCommentByType,
  useSubmissionController,
  useSubmissionMaybe,
  useSubmissionReviewForRubric,
  useSubmissionReviewOrGradingReview
} from "@/hooks/useSubmission";
import { useActiveReviewAssignment, useActiveReviewAssignmentId, useActiveRubricId } from "@/hooks/useSubmissionReview";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { Icon } from "@chakra-ui/react";
import { Select as ChakraReactSelect, OptionBase } from "chakra-react-select";
import { formatRelative } from "date-fns";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import path from "path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BsFileEarmarkCodeFill, BsFileEarmarkImageFill, BsThreeDots } from "react-icons/bs";
import { FaCheckCircle, FaLink, FaTimes, FaTimesCircle } from "react-icons/fa";
import { isRubricCheckDataWithOptions, RubricCheckSubOption } from "./code-file";
import PersonName from "./person-name";
import RegradeRequestWrapper from "./regrade-request-wrapper";
import RequestRegradeDialog from "./request-regrade-dialog";
import { Tooltip } from "./tooltip";

interface CheckOptionType extends OptionBase {
  value: number;
  label: string;
  rubricName?: string;
  reviewRound?: string;
}

/**
 * Inline reference management component for preview mode
 */
const InlineReferenceManager = function InlineReferenceManager({
  checkId,
  classId,
  currentRubricId
}: {
  checkId: number;
  classId: number;
  currentRubricId: number;
}) {
  const { assignment_id } = useParams();
  const [isAddingReference, setIsAddingReference] = useState(false);
  const [selectedCheckOption, setSelectedCheckOption] = useState<CheckOptionType | undefined>(undefined);

  // Get existing references for this check
  const referencingChecks = useReferenceCheckRecordsFromCheck(checkId);

  // Get rubrics and all checks directly from controllers
  const allRubrics = useRubrics();
  const allChecks = useAllRubricChecks();
  const otherRubrics = useMemo(
    () => allRubrics?.filter((rubric) => rubric.id !== currentRubricId) ?? [],
    [allRubrics, currentRubricId]
  );
  const { rubricCheckReferencesController } = useAssignmentController();

  // Build check options from other rubrics only
  const checkOptions: CheckOptionType[] = useMemo(() => {
    if (!allChecks || !allRubrics || !referencingChecks) return [];

    // Get checks for other rubrics
    const otherRubricIds = otherRubrics.map((r) => r.id);

    // Filter out negative/zero IDs (preview mode with unsaved rubric)
    const validRubricIds = otherRubricIds.filter((id) => id > 0);

    if (validRubricIds.length === 0) {
      // In preview mode with unsaved rubric, no references available
      return [];
    }

    const checksForOtherRubrics = allChecks.filter(
      (check) =>
        validRubricIds.includes(check.rubric_id) &&
        !referencingChecks.find((c) => c.referenced_rubric_check_id === check.id)
    );

    return checksForOtherRubrics.map((c) => {
      const rubric = allRubrics?.find((r) => r.id === c.rubric_id);
      return {
        value: c.id,
        label: `${c.name} (${c.points} pts)`,
        rubricName: rubric?.name || "Unknown",
        reviewRound: rubric?.review_round || "General"
      };
    });
  }, [allChecks, otherRubrics, allRubrics, referencingChecks]);

  const handleAddReference = useCallback(async () => {
    if (!selectedCheckOption) {
      toaster.error({
        title: "Error",
        description: "Please select a check to reference."
      });
      return;
    }

    try {
      await rubricCheckReferencesController.create({
        assignment_id: Number.parseInt(assignment_id as string),
        rubric_id: currentRubricId,
        referencing_rubric_check_id: checkId,
        referenced_rubric_check_id: selectedCheckOption.value,
        class_id: classId
      });
      toaster.success({
        title: "Reference Added",
        description: "The rubric check reference has been added successfully."
      });
      setIsAddingReference(false);
      setSelectedCheckOption(undefined);
    } catch (error) {
      toaster.error({
        title: "Error Adding Reference",
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    }
  }, [rubricCheckReferencesController, classId, selectedCheckOption, checkId, currentRubricId, assignment_id]);

  const handleDeleteReference = useCallback(
    async (referenceId: number) => {
      try {
        await rubricCheckReferencesController.hardDelete(referenceId);
        toaster.success({
          title: "Reference Removed",
          description: "The reference has been removed successfully."
        });
      } catch (error) {
        toaster.error({
          title: "Error Removing Reference",
          description: error instanceof Error ? error.message : "Unknown error occurred"
        });
      }
    },
    [rubricCheckReferencesController]
  );

  const existingReferences = referencingChecks || [];
  // If no options available and we're in preview mode, show a message
  if (checkOptions.length === 0 && currentRubricId <= 0) {
    return (
      <Box mt={2}>
        <Text fontSize="xs" color="fg.muted">
          Reference management will be available after saving this rubric.
        </Text>
      </Box>
    );
  }

  return (
    <Box mt={2}>
      {/* Show existing references */}
      {existingReferences.length > 0 && (
        <VStack gap={1} alignItems="stretch" mb={2}>
          {existingReferences.map((reference) => {
            if (!reference) return null;

            // Find the referenced check to get its name and points
            const referencedCheck = allChecks.find((check) => check.id === reference.referenced_rubric_check_id);
            if (!referencedCheck) return null;

            return (
              <HStack key={reference.id} fontSize="xs" gap={1} p={1} bg="bg.muted" borderRadius="sm">
                <Icon as={FaLink} color="blue.500" />
                <Text flex={1} truncate>
                  {referencedCheck.name} ({referencedCheck.points} pts)
                </Text>
                <Button
                  size="2xs"
                  variant="ghost"
                  colorPalette="red"
                  onClick={() => handleDeleteReference(reference.id)}
                >
                  <Icon as={FaTimes} />
                </Button>
              </HStack>
            );
          })}
        </VStack>
      )}

      {/* Add reference UI */}
      {!isAddingReference ? (
        <Button size="2xs" variant="outline" colorPalette="blue" onClick={() => setIsAddingReference(true)}>
          <Icon as={FaLink} mr={1} />
          Add Reference
        </Button>
      ) : (
        <VStack gap={2} p={2} borderWidth="1px" borderRadius="md" borderColor="border.default" bg="bg.canvas">
          <ChakraReactSelect<CheckOptionType, false>
            size="sm"
            options={checkOptions}
            value={selectedCheckOption}
            onChange={(option) => setSelectedCheckOption(option || undefined)}
            placeholder="Select check to reference..."
            aria-label="Select check to reference"
            isLoading={false}
            formatOptionLabel={(option) => (
              <VStack alignItems="flex-start" gap={0}>
                <Text fontSize="sm">{option.label}</Text>
                <Text fontSize="xs" color="fg.muted">
                  {option.rubricName} ({option.reviewRound})
                </Text>
              </VStack>
            )}
            chakraStyles={{
              menu: (provided) => ({ ...provided, zIndex: 10000 }),
              control: (provided) => ({ ...provided, minHeight: "auto" })
            }}
          />
          <HStack gap={1} w="100%">
            <Button
              size="2xs"
              colorPalette="green"
              onClick={handleAddReference}
              disabled={!selectedCheckOption}
              flex={1}
            >
              Add
            </Button>
            <Button
              size="2xs"
              variant="outline"
              onClick={() => {
                setIsAddingReference(false);
                setSelectedCheckOption(undefined);
              }}
              flex={1}
            >
              Cancel
            </Button>
          </HStack>
        </VStack>
      )}
    </Box>
  );
};

export function CommentActions({
  comment,
  setIsEditing
}: {
  comment: SubmissionFileComment | SubmissionComments | SubmissionArtifactComment;
  setIsEditing: (isEditing: boolean) => void;
}) {
  const submissionController = useSubmissionController();
  const { private_profile_id } = useClassProfiles();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const isInstructor = useIsInstructor();
  const isStudent = useIsStudent();

  // Get the submission review to check if it's completed
  const submissionReview = useSubmissionReviewOrGradingReview(comment.submission_review_id || -1);

  // Check if current user can edit/delete this comment
  // 1. Instructors can edit all comments
  // 2. Graders can only edit their own comments
  // 3. Students can edit their own comments IF the review is not completed (or no review exists)
  const isCommentAuthor = comment.author === private_profile_id;
  const isReviewCompleted = comment.submission_review_id ? submissionReview?.completed_at != null : false;

  const canEditComment =
    isInstructor || (isGraderOrInstructor && isCommentAuthor) || (isStudent && isCommentAuthor && !isReviewCompleted);

  // Don't show actions if user can't edit
  if (!canEditComment) {
    return null;
  }

  return (
    <HStack gap={1}>
      <Menu.Root
        onSelect={async (value) => {
          if (value.value === "edit") {
            setIsEditing(true);
          } else if (value.value === "delete") {
            if (comment.id === -1) {
              toaster.error({
                title: "Error",
                description:
                  "You cannot delete a comment that has not been saved yet. Please wait for it to finish saving before trying again, or refresh your browser to see if it was successfully saved."
              });
              return;
            }

            if (isLineComment(comment)) {
              submissionController.submission_file_comments.delete(comment.id);
            } else if (isArtifactComment(comment)) {
              submissionController.submission_artifact_comments.delete(comment.id);
            } else {
              submissionController.submission_comments.delete(comment.id);
            }
          }
        }}
      >
        <Menu.Trigger asChild>
          <Button p={0} m={2} colorPalette="blue" variant="ghost" size="2xs">
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
    </HStack>
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

  const baseUrl = linkToSubPage(pathname, "files");
  const queryParams = new URLSearchParams();
  queryParams.set("artifact_id", comment.submission_artifact_id.toString());

  return (
    <Link
      href={`${baseUrl}?${queryParams.toString()}`}
      prefetch={true}
      onClick={(e) => {
        // If already on files tab, switch client-side without navigation; otherwise allow normal navigation
        if (pathname.includes("/files")) {
          e.preventDefault();
          window.dispatchEvent(
            new CustomEvent("pawto:files-select", {
              detail: { artifactId: comment.submission_artifact_id }
            })
          );
        }
      }}
    >
      @ {shortFileName}
    </Link>
  );
}

export function SubmissionFileCommentLink({ comment }: { comment: SubmissionFileComment }) {
  const submission = useSubmissionMaybe();
  const pathname = usePathname();
  const existingSearchParams = useSearchParams();
  const file = submission?.submission_files.find((file) => file.id === comment.submission_file_id);
  if (!file || !submission) {
    return <></>;
  }
  const shortFileName = path.basename(file.name);
  const queryParams = new URLSearchParams(existingSearchParams.toString());
  queryParams.set("file_id", comment.submission_file_id.toString());

  const baseUrl = linkToSubPage(pathname, "files", queryParams);

  return (
    <Link
      href={`${baseUrl}#L${comment.line}`}
      prefetch={true}
      onClick={(e) => {
        if (pathname.includes("/files")) {
          e.preventDefault();
          window.dispatchEvent(
            new CustomEvent("pawto:files-select", {
              detail: { fileId: comment.submission_file_id, hash: `L${comment.line}` }
            })
          );
        }
      }}
    >
      @ {shortFileName}:{comment.line}
    </Link>
  );
}

export function RubricCheckComment({
  comment_type,
  comment_id,
  criteria,
  check
}: {
  comment_type: "file" | "artifact" | "submission";
  comment_id: number;
  criteria?: RubricCriteriaType;
  check?: RubricCheckType;
}) {
  const comment = useSubmissionCommentByType(comment_id, comment_type);
  const submissionController = useSubmissionController();
  const author = useUserProfile(comment?.author);
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const submission = useSubmissionMaybe();
  const boxRef = useRef<HTMLDivElement>(null);

  const isGraderOrInstructor = useIsGraderOrInstructor();
  const pathname = usePathname();

  // Auto-scroll to this regrade request if the URL hash matches
  useEffect(() => {
    if (comment?.regrade_request_id && boxRef.current) {
      const hash = window.location.hash;
      const targetId = `#regrade-request-${comment.regrade_request_id}`;

      if (hash === targetId) {
        // Small delay to ensure all rendering is complete
        setTimeout(() => {
          boxRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "center"
          });
        }, 100);
      }
    }
  }, [comment?.regrade_request_id]);

  const handleEditComment = useCallback(
    async (message: string) => {
      if (comment_type === "submission") {
        await submissionController.submission_comments.update(comment_id, { comment: message });
      } else if (comment_type === "file") {
        await submissionController.submission_file_comments.update(comment_id, { comment: message });
      } else if (comment_type === "artifact") {
        await submissionController.submission_artifact_comments.update(comment_id, { comment: message });
      }
      setIsEditing(false);
    },
    [comment_id, comment_type, setIsEditing, submissionController]
  );

  const linkedFileId =
    check?.file && submission ? submission.submission_files.find((f) => f.name === check.file)?.id : undefined;
  const linkedArtifactId =
    check?.artifact && submission
      ? submission.submission_artifacts.find((a) => a.name === check.artifact)?.id
      : undefined;
  if (!comment) {
    return <Skeleton w="100%" h="100px" />;
  }

  let pointsText = <></>;
  if (comment.points) {
    if (!criteria || criteria.is_additive) {
      pointsText = (
        <>
          <Icon as={FaCheckCircle} color="green.500" /> + {comment.points}
        </>
      );
    } else {
      pointsText = (
        <>
          <Icon as={FaTimesCircle} color="red.500" /> - {comment.points}
        </>
      );
    }
  }
  const hasPoints = comment.points !== null;
  // Check if student can create a regrade request
  const canCreateRegradeRequest = !isGraderOrInstructor && hasPoints && !comment.regrade_request_id && comment.released;

  return (
    <Box
      ref={boxRef}
      role="region"
      aria-label={`Grading check ${check?.name}`}
      id={comment.regrade_request_id ? `regrade-request-${comment.regrade_request_id}` : undefined}
    >
      <RegradeRequestWrapper regradeRequestId={comment.regrade_request_id}>
        <Box
          border="1px solid"
          borderColor={criteria ? "border.info" : "border.muted"}
          borderRadius="md"
          p={0}
          w="100%"
          fontSize="sm"
        >
          <Box bg={criteria ? "bg.info" : "bg.muted"} pl={1} borderTopRadius="md">
            <HStack justify="space-between">
              {comment.__db_pending && <Spinner size="sm" />}
              <Text fontSize="sm" color="fg.muted">
                {author?.name}
                {isGraderOrInstructor && author?.real_name && (
                  <Text as="span" fontSize="xs">
                    {" "}
                    ({author.real_name})
                  </Text>
                )}{" "}
                {criteria ? "applied" : "commented"} {formatRelative(comment.created_at, new Date())}
              </Text>
              <CommentActions comment={comment} setIsEditing={setIsEditing} />
            </HStack>
          </Box>
          <Box pl={1} pr={1} color="fg.muted">
            {check && (
              <Text fontSize="sm" fontWeight="semibold" mb={1} color="fg.default" wordBreak="break-word">
                {check.name}
              </Text>
            )}
            <HStack gap={1}>
              <Box flexShrink={0}>{pointsText}</Box>{" "}
              {isLineComment(comment) && <SubmissionFileCommentLink comment={comment} />}{" "}
              {isArtifactComment(comment) && <SubmissionArtifactCommentLink comment={comment} />}
              {!isLineComment(comment) && !isArtifactComment(comment) && linkedFileId && submission && check?.file && (
                <Box flexShrink={1}>
                  <Link
                    prefetch={true}
                    href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ file_id: linkedFileId.toString() }).toString()}`}
                  >
                    <Text as="span" fontSize="xs" color="fg.muted" wordWrap={"break-word"} wordBreak={"break-all"}>
                      {check.file}
                    </Text>
                  </Link>
                </Box>
              )}
              {!isLineComment(comment) &&
                !isArtifactComment(comment) &&
                linkedArtifactId &&
                submission &&
                check?.artifact && (
                  <Box flexShrink={1}>
                    <Link
                      prefetch={true}
                      href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ artifact_id: linkedArtifactId.toString() }).toString()}`}
                    >
                      <Text as="span" fontSize="xs" color="fg.muted" wordWrap={"break-word"} wordBreak={"break-all"}>
                        {check.artifact}
                      </Text>
                    </Link>
                  </Box>
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
                sendMessage={handleEditComment}
              />
            ) : (
              <Markdown>{comment.comment}</Markdown>
            )}
          </Box>
          {canCreateRegradeRequest && <RequestRegradeDialog comment={comment} />}
        </Box>
      </RegradeRequestWrapper>
    </Box>
  );
}

function ReferencedFeedbackHeader({ check_id }: { check_id: number }) {
  const rubricCheck = useRubricCheck(check_id);
  return (
    <Tooltip content={rubricCheck?.description || "No description"} showArrow>
      <Text fontSize="xs" fontWeight="bold" wordBreak="break-word">
        {rubricCheck?.name}
      </Text>
    </Tooltip>
  );
}

export function ReviewRoundTag({ submission_review_id }: { submission_review_id: number }) {
  const submissionReview = useSubmissionReviewOrGradingReview(submission_review_id);
  const rubric = useRubricById(submissionReview?.rubric_id);
  if (!submissionReview) {
    return null;
  }
  if (!rubric) {
    return null;
  }
  return (
    <Tag.Root minW="fit-content" flexShrink={0} size="sm" colorPalette="blue" variant="outline">
      <Tag.Label>{rubric.review_round}</Tag.Label>
    </Tag.Root>
  );
}

// New component to display referenced feedback
function ReferencedFeedbackDisplay({ referencing_check_id }: { referencing_check_id: number }) {
  const referencedFeedback = useReferencedRubricCheckInstances(referencing_check_id);

  if (!referencedFeedback || referencedFeedback.length === 0) {
    return null;
  }

  return (
    <Box mt={3} p={2} borderTop="1px dashed" borderColor="border.subtle" bg="bg.subtle">
      <Text fontWeight="bold" fontSize="sm" mb={2} color="fg.default">
        Related Feedback from Other Reviews:
      </Text>
      <VStack gap={3} alignItems="stretch">
        {referencedFeedback.map((instance, index) => (
          <Box key={index} p={2} borderWidth="1px" borderRadius="md" borderColor="border.default" bg="bg.canvas">
            <VStack alignItems="flex-start" mb={1.5}>
              <ReferencedFeedbackHeader check_id={instance.rubric_check_id!} />
              {isLineComment(instance) && <SubmissionFileCommentLink comment={instance} />}
              {isArtifactComment(instance) && <SubmissionArtifactCommentLink comment={instance} />}
              <ReviewRoundTag submission_review_id={instance.submission_review_id!} />
            </VStack>
            <HStack gap={1.5} alignItems="center" mb={1.5}>
              <PersonName uid={instance.author} size="2xs" showAvatar={true} />
              <Text fontSize="xs" color="fg.muted">
                {instance.points != null && ` (${instance.points > 0 ? "+" : ""}${instance.points} pts)`}
              </Text>
            </HStack>
            <Box fontSize="sm">
              <Markdown style={{ fontSize: "0.8rem" }}>{instance.comment}</Markdown>
            </Box>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}

export function StudentVisibilityIndicator({
  check,
  isApplied,
  isReleased
}: {
  check: HydratedRubricCheck;
  isApplied: boolean;
  isReleased: boolean;
}) {
  const isGrader = useIsGraderOrInstructor();

  // Only show indicators to graders/instructors
  if (!isGrader) {
    return null;
  }

  const getVisibilityInfo = () => {
    switch (check.student_visibility) {
      case "never":
        return {
          text: "This will never be visible to students",
          color: "red",
          icon: "🔴"
        };
      case "if_applied":
        return {
          text: isApplied
            ? "This will be visible to the student when released their submission is released"
            : "This will only be visible to the student after it has been applied to their submission and the review is released",
          color: isApplied && isReleased ? "green" : "orange",
          icon: isApplied && isReleased ? "🟢" : isApplied && !isReleased ? "⏳" : "🟠"
        };
      case "if_released":
        return {
          text: isReleased
            ? "This will be visible to the student now that their review is released"
            : "This will only be visible to the student after the review is released",
          color: isReleased ? "green" : "orange",
          icon: isReleased ? "🟢" : "⏳"
        };
      case "always":
      default:
        return {
          text: "This will be visible to all students with this assignment",
          color: "green",
          icon: "🟢"
        };
    }
  };

  const { text, icon } = getVisibilityInfo();

  return (
    <Tooltip content={text}>
      <Badge variant="outline" style={{ fontSize: "10px", padding: "2px 4px" }}>
        {icon}
      </Badge>
    </Tooltip>
  );
}

export function RubricCheckAnnotation({
  check,
  criteria,
  assignmentId,
  classId,
  currentRubricId
}: {
  check: RubricCheckType;
  criteria: RubricCriteriaType;
  assignmentId?: number;
  classId?: number;
  currentRubricId?: number;
}) {
  const reviewForThisRubric = useSubmissionReviewForRubric(currentRubricId);
  const rubricCheckComments = useRubricCheckInstances(check as RubricChecks, reviewForThisRubric?.id);
  const isGrader = useIsGraderOrInstructor();
  const gradingIsRequired = isGrader && check.is_required && rubricCheckComments.length == 0;
  const annotationTarget = check.annotation_target || "file";
  const submission = useSubmissionMaybe();
  const isPreviewMode = !submission;
  const activeAssignmentReview = useActiveReviewAssignment();
  const gradingIsPermitted =
    isGrader ||
    (activeAssignmentReview &&
      reviewForThisRubric &&
      activeAssignmentReview.submission_review_id === reviewForThisRubric.id);

  // Check if this check should be visible to the current user
  const shouldShowCheck = useShouldShowRubricCheck({
    check,
    rubricCheckComments,
    reviewForThisRubric,
    isGrader,
    isPreviewMode
  });

  if (!shouldShowCheck) {
    return null;
  }

  const isApplied = rubricCheckComments.length > 0;
  const isReleased = reviewForThisRubric?.released || false;

  return (
    <Box
      border="1px solid"
      borderColor={gradingIsRequired ? "border.error" : "border.emphasized"}
      borderRadius="md"
      p={1}
      w="100%"
    >
      <HStack justify="space-between">
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
        <StudentVisibilityIndicator check={check} isApplied={isApplied} isReleased={isReleased} />
      </HStack>
      <Markdown
        style={{
          fontSize: "0.8rem"
        }}
      >
        {check.description}
      </Markdown>
      {rubricCheckComments.map((comment) => (
        <RubricCheckComment
          key={comment.id}
          comment_id={comment.id}
          comment_type="file"
          criteria={criteria}
          check={check}
        />
      ))}

      {/* Inline reference management for preview mode */}
      {isPreviewMode && assignmentId && classId && currentRubricId ? (
        <InlineReferenceManager checkId={check.id} classId={classId} currentRubricId={currentRubricId} />
      ) : (
        <></>
      )}

      {/* Show referenced feedback for grading mode */}
      {!isPreviewMode && gradingIsPermitted && <ReferencedFeedbackDisplay referencing_check_id={check.id} />}
    </Box>
  );
}

export function RubricCheckGlobal({
  check,
  criteria,
  isSelected,
  assignmentId,
  classId,
  currentRubricId
}: {
  check: RubricCheckType;
  criteria: RubricCriteriaType;
  isSelected: boolean;
  assignmentId?: number;
  classId?: number;
  currentRubricId?: number;
}) {
  const reviewForThisRubric = useSubmissionReviewForRubric(currentRubricId);
  const rubricCheckComments = useRubricCheckInstances(check as RubricChecks, reviewForThisRubric?.id);
  const criteriaCheckComments = useRubricCriteriaInstances({
    criteria: criteria,
    review_id: reviewForThisRubric?.id
  });

  // Move all useState calls before any early returns
  const [checkboxIsChecked, setCheckboxIsChecked] = useState<boolean>(rubricCheckComments.length > 0);
  const [isEditing, setIsEditing] = useState<boolean>(isSelected && rubricCheckComments.length === 0);
  const hasOptions = isRubricCheckDataWithOptions(check.data) && check.data.options.length > 0;
  const _selectedOptionIndex =
    hasOptions && rubricCheckComments.length == 1 && isRubricCheckDataWithOptions(check.data)
      ? check.data.options.findIndex((option: RubricCheckSubOption) => option.points === rubricCheckComments[0].points)
      : undefined;
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number | undefined>(_selectedOptionIndex);
  useEffect(() => {
    if (_selectedOptionIndex !== undefined) {
      setSelectedOptionIndex(_selectedOptionIndex);
    }
  }, [_selectedOptionIndex]);

  const onCommentSuccess = useCallback(() => {
    setIsEditing(false);
  }, []);

  const submission = useSubmissionMaybe();
  const isGrader = useIsGraderOrInstructor();
  const pathname = usePathname();
  const isPreviewMode = !submission;
  const linkedAritfactId = check.artifact
    ? submission?.submission_artifacts.find((artifact) => artifact.name === check.artifact)?.id
    : undefined;
  const linkedFileId = check.file
    ? submission?.submission_files.find((file) => file.name === check.file)?.id
    : undefined;
  const activeAssignmentReview = useActiveReviewAssignment();

  // Check if this check should be visible to the current user
  const shouldShowCheck = useShouldShowRubricCheck({
    check,
    rubricCheckComments,
    reviewForThisRubric,
    isGrader,
    isPreviewMode
  });

  useEffect(() => {
    setCheckboxIsChecked(rubricCheckComments.length > 0);
  }, [rubricCheckComments.length]);
  useEffect(() => {
    if (!checkboxIsChecked) {
      setIsEditing(
        isSelected &&
          rubricCheckComments.length === 0 &&
          criteria.max_checks_per_submission != criteriaCheckComments.length
      );
    }
  }, [
    isSelected,
    rubricCheckComments.length,
    criteria.max_checks_per_submission,
    criteriaCheckComments.length,
    checkboxIsChecked
  ]);

  if (!shouldShowCheck) {
    return null;
  }

  const points = check.points === 0 ? "" : criteria.is_additive ? `+${check.points}` : `-${check.points}`;
  const format = criteria.max_checks_per_submission != 1 ? "checkbox" : "radio";
  const gradingIsRequired = reviewForThisRubric && check.is_required && rubricCheckComments.length == 0;
  const gradingIsPermitted =
    (isGrader ||
      (activeAssignmentReview &&
        reviewForThisRubric &&
        activeAssignmentReview.submission_review_id === reviewForThisRubric.id)) &&
    reviewForThisRubric &&
    (criteria.max_checks_per_submission === null ||
      criteriaCheckComments.length < (criteria.max_checks_per_submission || 1000));
  const showOptions = (gradingIsPermitted || isPreviewMode) && hasOptions;

  const isApplied = rubricCheckComments.length > 0;
  const isReleased = reviewForThisRubric?.released || false;

  return (
    <Box position="relative" width="100%">
      <Field.Root>
        <HStack justify="space-between" align="flex-start">
          <Box flex="1">
            {showOptions && (
              <VStack
                align="flex-start"
                w="100%"
                gap={0}
                borderColor={gradingIsRequired ? "border.error" : "border.emphasized"}
                borderWidth={gradingIsRequired ? "1px" : "0px"}
                borderRadius="md"
                p={1}
                wordBreak="break-word"
              >
                <HStack justify="space-between" w="100%">
                  <Field.Label>
                    <Text fontSize="sm">{check.name}</Text>
                  </Field.Label>
                  <StudentVisibilityIndicator check={check} isApplied={isApplied} isReleased={isReleased} />
                </HStack>
                <Markdown
                  style={{
                    fontSize: "0.8rem"
                  }}
                >
                  {check.description}
                </Markdown>
                {linkedFileId && submission && (
                  <Link
                    prefetch={true}
                    href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ file_id: linkedFileId.toString() }).toString()}`}
                  >
                    <Text as="span" fontSize="xs" color="fg.muted" wordWrap={"break-word"} wordBreak={"break-all"}>
                      In: {check.file}
                    </Text>
                  </Link>
                )}
                {linkedAritfactId && submission && (
                  <Link
                    prefetch={true}
                    href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ artifact_id: linkedAritfactId.toString() }).toString()}`}
                  >
                    <Text as="span" fontSize="xs" color="fg.muted" wordWrap={"break-word"} wordBreak={"break-all"}>
                      In: {check.artifact}
                    </Text>
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
                    if (isRubricCheckDataWithOptions(check.data) && value.value !== null) {
                      const selectedOption = check.data.options[parseInt(value.value)];
                      if (selectedOption) {
                        setSelectedOptionIndex(parseInt(value.value!));
                        if (gradingIsPermitted) {
                          setIsEditing(true);
                        }
                      }
                    }
                  }}
                >
                  {isRubricCheckDataWithOptions(check.data) &&
                    check.data.options.map((option: RubricCheckSubOption, index: number) => (
                      <Radio
                        disabled={rubricCheckComments.length > 0 || !reviewForThisRubric || !gradingIsPermitted}
                        key={option.label + "-" + index}
                        value={index.toString()}
                      >
                        {option.points ? `${criteria.is_additive ? "+" : "-"} ${option.points} ` : ""}
                        {option.label}
                      </Radio>
                    ))}
                </RadioGroup.Root>
              </VStack>
            )}
            {!hasOptions && format == "checkbox" && (
              <VStack
                align="flex-start"
                w="100%"
                borderColor={gradingIsRequired ? "border.error" : "border.emphasized"}
                borderWidth={gradingIsRequired ? "1px" : "0px"}
                borderRadius="md"
              >
                <HStack justify="space-between" w="100%">
                  <Checkbox
                    disabled={rubricCheckComments.length > 0 || !reviewForThisRubric || !gradingIsPermitted}
                    checked={checkboxIsChecked || isSelected}
                    aria-label={`${check.name} (${points})`}
                    onCheckedChange={(newState) => {
                      if (newState.checked) {
                        setIsEditing(true);
                      } else {
                        setIsEditing(false);
                      }
                      setCheckboxIsChecked(newState.checked ? true : false);
                    }}
                  >
                    <Field.Label>
                      <Text>
                        {points} {check.name}
                      </Text>
                    </Field.Label>
                    <Markdown
                      style={{
                        fontSize: "0.8rem"
                      }}
                    >
                      {check.description}
                    </Markdown>
                  </Checkbox>
                  <StudentVisibilityIndicator check={check} isApplied={isApplied} isReleased={isReleased} />
                </HStack>

                {linkedFileId && submission && (
                  <Link
                    href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ file_id: linkedFileId.toString() }).toString()}`}
                  >
                    <Text as="span" fontSize="xs" color="fg.muted" wordWrap={"break-word"} wordBreak={"break-all"}>
                      In: {check.file}
                    </Text>
                  </Link>
                )}
                {linkedAritfactId && submission && (
                  <Link
                    prefetch={true}
                    href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ artifact_id: linkedAritfactId.toString() }).toString()}`}
                  >
                    <Text as="span" fontSize="xs" color="fg.muted" wordWrap={"break-word"} wordBreak={"break-all"}>
                      In: {check.artifact}
                    </Text>
                  </Link>
                )}
              </VStack>
            )}
            {!hasOptions && format == "radio" && (
              <VStack
                align="flex-start"
                w="100%"
                borderColor={gradingIsRequired ? "border.error" : "border.emphasized"}
                borderWidth={gradingIsRequired ? "1px" : "0px"}
                borderRadius="md"
              >
                <HStack justify="space-between" w="100%">
                  <Radio value={check.id.toString()} disabled={rubricCheckComments.length > 0 || !reviewForThisRubric}>
                    <Field.Label>
                      <Text>
                        {points} {check.name}
                      </Text>
                    </Field.Label>
                    <Markdown
                      style={{
                        fontSize: "0.8rem"
                      }}
                    >
                      {check.description}
                    </Markdown>
                  </Radio>
                  <StudentVisibilityIndicator check={check} isApplied={isApplied} isReleased={isReleased} />
                </HStack>
                {linkedFileId && submission && (
                  <Link
                    prefetch={true}
                    href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ file_id: linkedFileId.toString() }).toString()}`}
                  >
                    <Text as="span" fontSize="xs" color="fg.muted" wordWrap={"break-word"} wordBreak={"break-all"}>
                      In: {check.file}
                    </Text>
                  </Link>
                )}
                {linkedAritfactId && submission && (
                  <Link
                    prefetch={true}
                    href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ artifact_id: linkedAritfactId.toString() }).toString()}`}
                  >
                    <Text as="span" fontSize="xs" color="fg.muted" wordWrap={"break-word"} wordBreak={"break-all"}>
                      In: {check.artifact}
                    </Text>
                  </Link>
                )}
              </VStack>
            )}
          </Box>
        </HStack>
      </Field.Root>
      {isEditing && (
        <SubmissionCommentForm
          check={check}
          submissionReview={reviewForThisRubric}
          selectedOptionIndex={selectedOptionIndex}
          linkedArtifactId={linkedAritfactId}
          onSuccess={onCommentSuccess}
        />
      )}
      {rubricCheckComments.map((comment) => (
        <RubricCheckComment
          key={comment.id}
          comment_id={comment.id}
          comment_type="submission"
          criteria={criteria}
          check={check}
        />
      ))}

      {/* Inline reference management for preview mode */}
      {isPreviewMode && assignmentId && classId && currentRubricId && (
        <InlineReferenceManager checkId={check.id} classId={classId} currentRubricId={currentRubricId} />
      )}

      {/* Show referenced feedback for grading mode */}
      {!isPreviewMode && gradingIsPermitted && <ReferencedFeedbackDisplay referencing_check_id={check.id} />}
    </Box>
  );
}

/**
 * Renders a form for adding a comment to a rubric check within a submission review.
 *
 * Focuses the input on mount and constructs the comment text, optionally including the selected option label.
 * Creates a new submission comment when submitted, linking to an artifact if applicable.
 * Invokes the `onSuccess` callback after initiating comment creation.
 *
 * @param check - The rubric check to comment on.
 * @param submissionReview - The current submission review context, if any.
 * @param selectedOptionIndex - Index of the selected option for option-based checks.
 * @param linkedArtifactId - ID of the artifact to link the comment to, if applicable.
 * @param onSuccess - Callback invoked after the comment creation process is initiated.
 */
function SubmissionCommentForm({
  check,
  submissionReview,
  selectedOptionIndex,
  linkedArtifactId,
  onSuccess
}: {
  check: HydratedRubricCheck;
  submissionReview?: SubmissionReview;
  selectedOptionIndex?: number;
  linkedArtifactId?: number;
  onSuccess: () => void;
}) {
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const submission = useSubmissionMaybe();
  const submissionController = useSubmissionController();
  const { private_profile_id, public_profile_id } = useClassProfiles();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const graderPseudonymousMode = useGraderPseudonymousMode();
  // Use public profile (pseudonym) when grader pseudonymous mode is enabled and user is staff
  const authorProfileId = isGraderOrInstructor && graderPseudonymousMode ? public_profile_id : private_profile_id;

  useEffect(() => {
    if (messageInputRef.current) {
      messageInputRef.current.focus();
    }
  }, []);

  if (!submission) {
    return <></>;
  }

  const selectedOption =
    selectedOptionIndex !== undefined && isRubricCheckDataWithOptions(check.data)
      ? check.data.options[selectedOptionIndex]
      : undefined;
  return (
    <Box border="1px solid" borderColor="border.inverted" borderRadius="md" p={0} w="100%" fontSize="sm">
      <Box bg="bg.inverted" pl={1} borderTopRadius="md">
        <Text color="fg.inverted">
          Check not yet applied.{" "}
          {check.is_comment_required ? "A comment is required." : "Comment is optional, enter to add."}
        </Text>
      </Box>
      <MessageInput
        ariaLabel={
          check.is_comment_required
            ? `Required: comment on check ${check.name}`
            : `Optional: comment on check ${check.name}`
        }
        placeholder={"Comment"}
        sendButtonText="Add Check"
        sendMessage={async (message) => {
          let comment = message || "";
          if (selectedOptionIndex !== undefined) {
            comment = selectedOption?.label + "\n" + comment;
          }
          const artifactInfo = check.artifact
            ? {
                submission_artifact_id: linkedArtifactId
              }
            : {};

          const values = {
            comment,
            rubric_check_id: check.id,
            class_id: submission.class_id,
            submission_id: submission.id,
            // Use the determined author profile based on grader pseudonymous mode
            author: authorProfileId,
            points: selectedOption?.points !== undefined ? selectedOption.points : check.points,
            released: submissionReview?.released ?? true,
            submission_review_id: submissionReview?.id ?? null,
            eventually_visible: true,
            regrade_request_id: null,
            ...artifactInfo
          };
          onSuccess();
          if (check.is_annotation) {
            throw new Error("Not implemented");
          } else {
            await submissionController.submission_comments.create(values);
          }
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
  assignmentId,
  classId,
  currentRubricId
}: {
  criteria: RubricCriteriaType;
  check: RubricCheckType;
  isSelected: boolean;
  assignmentId?: number;
  classId?: number;
  currentRubricId?: number;
}) {
  return (
    <Box p={0} w="100%">
      {check.is_annotation ? (
        <RubricCheckAnnotation
          check={check}
          criteria={criteria}
          assignmentId={assignmentId}
          classId={classId}
          currentRubricId={currentRubricId}
        />
      ) : (
        <RubricCheckGlobal
          check={check}
          criteria={criteria}
          isSelected={isSelected}
          assignmentId={assignmentId}
          classId={classId}
          currentRubricId={currentRubricId}
        />
      )}
    </Box>
  );
}

export function RubricCriteria({
  criteria,
  assignmentId,
  classId,
  currentRubricId
}: {
  criteria: RubricCriteriaType;
  assignmentId?: number;
  classId?: number;
  currentRubricId?: number;
}) {
  const reviewForThisRubric = useSubmissionReviewForRubric(currentRubricId);
  const comments = useRubricCriteriaInstances({
    criteria: criteria,
    review_id: reviewForThisRubric?.id
  });
  const totalPoints = comments.reduce((acc, comment) => acc + (comment.points || 0), 0);
  const isAdditive = criteria.is_additive;
  const [selectedCheck, setSelectedCheck] = useState<HydratedRubricCheck>();
  let pointsText = "";
  if (criteria.total_points) {
    if (criteria.is_deduction_only) {
      pointsText = `-${totalPoints}/${criteria.total_points}`;
    } else if (isAdditive) {
      pointsText = `${totalPoints}/${criteria.total_points}`;
    } else {
      pointsText = `${criteria.total_points - totalPoints}/${criteria.total_points}`;
    }
  }
  const isGrader = useIsGraderOrInstructor();
  const gradingIsRequired =
    isGrader && reviewForThisRubric && comments.length < (criteria.min_checks_per_submission || 0);
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
  const unsortedRubricChecks = useRubricChecksByCriteria(criteria.id);
  const rubricChecks = useMemo(() => {
    return [...unsortedRubricChecks].sort((a, b) => a.ordinal - b.ordinal);
  }, [unsortedRubricChecks]);
  return (
    <Box
      border="1px solid"
      borderColor={gradingIsRequired ? "border.error" : "border.muted"}
      borderRadius="md"
      p={1}
      w="100%"
    >
      <Fieldset.Root>
        <Heading size="sm">
          <HStack gap={1}>
            <Fieldset.Legend>{criteria.name}</Fieldset.Legend> {pointsText}
          </HStack>
        </Heading>

        <Fieldset.HelperText>
          <Markdown
            style={{
              fontSize: "0.8rem"
            }}
          >
            {criteria.description}
          </Markdown>
        </Fieldset.HelperText>
        <Fieldset.Content>
          <VStack align="flex-start" w="100%" gap={0}>
            <Heading size="sm">Checks</Heading>
            <Text fontSize="sm" color={gradingIsRequired ? "fg.error" : "fg.muted"}>
              {instructions}
            </Text>
            <RadioGroup.Root
              w="100%"
              value={singleCheck}
              onValueChange={(value) => {
                setSelectedCheck(rubricChecks?.find((check) => check.id.toString() === value.value));
              }}
            >
              {rubricChecks?.map((check, index) => (
                <RubricCheck
                  key={`check-${check.id}-${index}`}
                  criteria={criteria}
                  check={check}
                  isSelected={selectedCheck?.id === check.id}
                  assignmentId={assignmentId}
                  classId={classId}
                  currentRubricId={currentRubricId}
                />
              ))}
            </RadioGroup.Root>
          </VStack>
        </Fieldset.Content>
      </Fieldset.Root>
    </Box>
  );
}

export function RubricPart({
  part,
  assignmentId,
  classId,
  currentRubricId
}: {
  part: RubricPartType;
  assignmentId?: number;
  classId?: number;
  currentRubricId?: number;
}) {
  const unsortedCriteria = useRubricCriteriaByPart(part?.id);
  const criteria = [...unsortedCriteria].sort((a, b) => a.ordinal - b.ordinal);
  return (
    <Box w="100%" role="region" aria-label={`Rubric Part: ${part.name}`}>
      <Heading size="md">{part.name}</Heading>
      <Markdown>{part.description}</Markdown>
      <VStack align="start" w="100%" gap={2}>
        {criteria.map((criteria, index) => (
          <RubricCriteria
            key={`criteria-${criteria.id}-${index}`}
            criteria={criteria}
            assignmentId={assignmentId}
            classId={classId}
            currentRubricId={currentRubricId}
          />
        ))}
      </VStack>
    </Box>
  );
}
function RubricMenu() {
  const { activeRubricId, setScrollToRubricId } = useActiveRubricId();
  const rubrics = useRubrics();
  const options = rubrics.map((rubric) => ({ value: rubric.id, label: rubric.name }));
  if (rubrics.length === 1) {
    return <></>;
  }

  return (
    <Box w="100%" position="sticky" top={0} zIndex={1} bg="bg.muted" pb={2}>
      <NativeSelectRoot>
        <NativeSelectField
          aria-label="Select active rubric"
          title="Select active rubric"
          value={activeRubricId}
          onChange={(e) => {
            setScrollToRubricId(Number(e.target.value));
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              Active Rubric: {option.label}
            </option>
          ))}
        </NativeSelectField>
      </NativeSelectRoot>
    </Box>
  );
}
export function ListOfRubricsInSidebar({ scrollRootRef }: { scrollRootRef: React.RefObject<HTMLDivElement> }) {
  const unsortedRubrics = useRubrics();
  const { activeRubricId, setActiveRubricId, scrollToRubricId, setScrollToRubricId } = useActiveRubricId();
  const activeReviewAssignment = useActiveReviewAssignment();
  const rubrics = useMemo(() => {
    return unsortedRubrics.sort((a, b) => {
      if (a.id === activeReviewAssignment?.rubric_id) {
        return -1;
      }
      if (b.id === activeReviewAssignment?.rubric_id) {
        return 1;
      }
      return a.id - b.id;
    });
  }, [unsortedRubrics, activeReviewAssignment]);
  // Refs for each rubric box
  const rubricRefs = useRef<{ [id: number]: HTMLDivElement | null }>({});
  // Flag to temporarily disable scroll handler during manual selection
  const isManuallySelecting = useRef<boolean>(false);

  // Scroll event logic for active rubric - simplified with hash-based state
  useEffect(() => {
    let scrollTimeout: NodeJS.Timeout | null = null;

    const handleScroll = () => {
      // Clear any existing timeout to debounce the scroll handling
      if (scrollTimeout !== null) {
        clearTimeout(scrollTimeout);
        scrollTimeout = null;
      }

      scrollTimeout = setTimeout(() => {
        if (!scrollRootRef.current) return;

        const container = scrollRootRef.current;
        const containerRect = container.getBoundingClientRect();

        let bestId: number | undefined = undefined;
        let bestTop: number | undefined = undefined;

        for (const rubric of rubrics) {
          const ref = rubricRefs.current[rubric.id];
          if (ref) {
            const boxRect = ref.getBoundingClientRect();
            const relativeTop = boxRect.top - containerRect.top;
            const relativeBottom = boxRect.bottom - containerRect.top;

            // Check if this rubric is at least partially visible in the container
            const isVisible = relativeBottom > 0 && relativeTop < containerRect.height;

            if (isVisible) {
              // For visible rubrics, find the one closest to the top of the container
              if (bestTop === undefined || Math.abs(relativeTop) < Math.abs(bestTop)) {
                bestTop = relativeTop;
                bestId = rubric.id;
              }
            }
          }
        }

        // Only update active rubric if we found a visible one, it's different, and we're not manually selecting
        if (bestId !== undefined && bestId !== activeRubricId && !isManuallySelecting.current) {
          setActiveRubricId(bestId);
        }
      }, 100); // 100ms debounce
    };

    const container = scrollRootRef.current;
    if (container) {
      container.addEventListener("scroll", handleScroll, { passive: true });
      handleScroll();
    }

    return () => {
      if (scrollTimeout !== null) {
        clearTimeout(scrollTimeout);
        scrollTimeout = null;
      }
      if (container) {
        container.removeEventListener("scroll", handleScroll);
      }
    };
  }, [rubrics, setActiveRubricId, scrollRootRef, activeRubricId]);

  // Scroll to active rubric when it changes
  useEffect(() => {
    let manualSelectTimeout: NodeJS.Timeout | null = null;

    if (scrollToRubricId && rubricRefs.current[scrollToRubricId]) {
      const container = scrollRootRef.current;
      const target = rubricRefs.current[scrollToRubricId];
      if (!container || !target) return;

      // Set flag to prevent scroll handler from interfering
      isManuallySelecting.current = true;

      // Immediately set the active rubric to the selected one
      setActiveRubricId(scrollToRubricId);

      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const offset = 30;
      const scrollTop = container.scrollTop + (targetRect.top - containerRect.top) - offset;
      container.scrollTo({ top: scrollTop, behavior: "smooth" });

      // Clear the flag after scroll animation completes
      manualSelectTimeout = setTimeout(() => {
        isManuallySelecting.current = false;
      }, 1000); // Give time for smooth scroll to complete

      setScrollToRubricId(undefined);
    }

    return () => {
      if (manualSelectTimeout !== null) {
        clearTimeout(manualSelectTimeout);
        manualSelectTimeout = null;
      }
    };
  }, [scrollToRubricId, scrollRootRef, setScrollToRubricId, setActiveRubricId]);

  // Callback to set refs
  const setRubricRef = useCallback(
    (id: number) => (el: HTMLDivElement | null) => {
      rubricRefs.current[id] = el;
    },
    []
  );

  return (
    <VStack w="100%">
      <RubricMenu />
      {rubrics.map((rubric, index) => (
        <Box
          key={rubric.id}
          id={`rubric-${rubric.id}`}
          data-rubric-id={rubric.id}
          ref={setRubricRef(rubric.id)}
          pt="40px"
          w="100%"
          role="region"
          aria-label={`Rubric: ${rubric.name}`}
        >
          <RubricSidebar key={rubric.id} rubricId={rubric.id} />
          {index < rubrics.length - 1 && (
            <Separator orientation="horizontal" borderTopWidth="4px" borderColor="border.emphasized" my={2} mt="50px" />
          )}
        </Box>
      ))}
    </VStack>
  );
}

export function RubricSidebar({ rubricId }: { rubricId: number }) {
  /*
  What this sidebar should show:
    - If we are an instructor, show all rubrics, with a focus on the grading rubric
    - If we are a grader, show the grading rubric, and if we have an assigned rubric, focus on that.
    - If we are a student and have an active (unsubmitted) assigned review, show that. If we have a graded review, show that ALSO
  */

  const activeReviewAssignmentId = useActiveReviewAssignmentId();
  const assignmentController = useAssignmentController();
  const activeAssignmentReview = useReviewAssignment(activeReviewAssignmentId);
  const reviewAssignmentRubricParts = useReviewAssignmentRubricParts(activeReviewAssignmentId);
  const rubric = useRubricById(rubricId);
  const isGrader = useIsGraderOrInstructor();
  const reviewForThisRubric = useSubmissionReviewForRubric(rubricId);
  const viewOnly = !isGrader && !reviewForThisRubric;
  const rubricParts = useRubricParts(rubricId);

  if (!rubric) {
    return (
      <Box p={2} maxW="lg" key="no-rubric-sidebar">
        <Text>No rubric information available.</Text>
      </Box>
    );
  }

  // Determine which parts to display
  let partsToDisplay: RubricPartType[] = [];
  if (
    activeAssignmentReview &&
    activeAssignmentReview.rubric_id === rubricId &&
    reviewAssignmentRubricParts?.length > 0
  ) {
    partsToDisplay =
      rubricParts
        ?.filter((part) => reviewAssignmentRubricParts.some((linkedPart) => linkedPart.rubric_part_id === part.id))
        .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)) || [];
  } else {
    partsToDisplay = rubricParts ? [...rubricParts].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)) : [];
  }

  if (partsToDisplay.length === 0) {
    return (
      <Box borderLeftWidth="1px" borderColor="border.emphasized" p={2} ml={0} key="empty-parts-sidebar">
        <VStack align="start" w="100%">
          <Heading size="xl">Grading Rubric</Heading>
          <Text fontSize="lg" fontWeight="semibold">
            {rubric.name}
          </Text>
          {rubric.description && <Markdown>{rubric.description}</Markdown>}
          <Text mt={2}>This rubric is empty.</Text>
        </VStack>
      </Box>
    );
  }

  return (
    <Box p={0} ml={0}>
      <VStack align="start" w="100%">
        <Text fontSize="lg" fontWeight="semibold">
          {rubric.name}
        </Text>
        {viewOnly && (
          <Text fontSize="sm" color="text.muted" mb={2}>
            This rubric is informational only. Your submission has not been graded yet. Once it is graded, you will see
            how this rubric was applied to grade your submission.
          </Text>
        )}
        {activeAssignmentReview && (
          <Box fontSize="sm" color="text.muted" mb={2}>
            {activeAssignmentReview.due_date && (
              <Text>
                Due: <TimeZoneAwareDate date={activeAssignmentReview.due_date} format="full" />
              </Text>
            )}
            {activeAssignmentReview.release_date && (
              <Text>
                Grades Release: <TimeZoneAwareDate date={activeAssignmentReview.release_date} format="full" />
              </Text>
            )}
          </Box>
        )}
        {partsToDisplay.map((part) => (
          <RubricPart
            key={part.name + "-" + part.id}
            part={part}
            assignmentId={assignmentController.assignment.id}
            classId={assignmentController.assignment.class_id}
            currentRubricId={rubric?.id}
          />
        ))}
      </VStack>
    </Box>
  );
}
