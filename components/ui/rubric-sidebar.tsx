"use client";
import { Button } from "@/components/ui/button";
import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart,
  RubricCheckReference,
  RubricChecks,
  RubricCriteriaWithRubricChecks,
  SubmissionArtifactComment,
  SubmissionComments,
  SubmissionFileComment,
  SubmissionReview
} from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Menu, Popover, Portal, RadioGroup, Skeleton, Tag, Text, VStack } from "@chakra-ui/react";

import { linkToSubPage } from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/utils";
import { Checkbox } from "@/components/ui/checkbox";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import { Radio } from "@/components/ui/radio";
import { toaster } from "@/components/ui/toaster";
import { useRubricCheck, useRubrics } from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import {
  useReferencedRubricCheckInstances,
  useReviewAssignment,
  useRubricCheckInstances,
  useRubricCriteriaInstances,
  useSubmissionMaybe,
  useSubmissionReview,
  useSubmissionRubric,
  useWritableReferencingRubricChecks,
  useWritableSubmissionReviews
} from "@/hooks/useSubmission";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { Icon } from "@chakra-ui/react";
import { useCreate, useDelete, useList, useUpdate } from "@refinedev/core";
import { Select as ChakraReactSelect, OptionBase, Select } from "chakra-react-select";
import { format, formatRelative } from "date-fns";
import { usePathname, useSearchParams } from "next/navigation";
import path from "path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BsFileEarmarkCodeFill, BsFileEarmarkImageFill, BsThreeDots } from "react-icons/bs";
import { FaCheckCircle, FaGraduationCap, FaLink, FaTimes, FaTimesCircle } from "react-icons/fa";
import { formatPoints, isRubricCheckDataWithOptions, RubricCheckSubOption, RubricCheckSubOptions } from "./code-file";
import PersonName from "./person-name";
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
function InlineReferenceManager({
  check,
  assignmentId,
  classId,
  currentRubricId
}: {
  check: HydratedRubricCheck;
  assignmentId: number;
  classId: number;
  currentRubricId: number;
}) {
  const [isAddingReference, setIsAddingReference] = useState(false);
  const [selectedCheckOption, setSelectedCheckOption] = useState<CheckOptionType | undefined>(undefined);

  // Get existing references for this check
  const { data: existingReferencesData, refetch: refetchReferences } = useList<RubricCheckReference>({
    resource: "rubric_check_references",
    filters: [
      { field: "referencing_rubric_check_id", operator: "eq", value: check.id },
      { field: "class_id", operator: "eq", value: classId }
    ],
    queryOptions: {
      enabled: !!assignmentId && !!classId && check.id > 0
    }
  });

  // Use cached rubrics data instead of making new API request
  const allRubrics = useRubrics();
  const otherRubrics = allRubrics.filter((rubric) => rubric.id !== currentRubricId);

  // Get details of referenced checks using cached data from assignment controller
  const referencedCheckIds = existingReferencesData?.data?.map((ref) => ref.referenced_rubric_check_id) || [];

  // Create a map of all rubric checks for fast lookup
  const rubricCheckById = useMemo(() => {
    const checkById = new Map<number, HydratedRubricCheck>();

    allRubrics.forEach((rubric) => {
      rubric.rubric_parts.forEach((part) => {
        part.rubric_criteria.forEach((criteria) => {
          criteria.rubric_checks.forEach((check) => {
            checkById.set(check.id, check);
          });
        });
      });
    });

    return checkById;
  }, [allRubrics]);

  const referencedChecks = referencedCheckIds
    .map((id) => rubricCheckById.get(id))
    .filter(Boolean) as HydratedRubricCheck[];

  const { mutate: createReference } = useCreate();
  const { mutate: deleteReference } = useDelete();

  // Build check options from other rubrics only
  const checkOptions: CheckOptionType[] = otherRubrics.flatMap((rubric) =>
    rubric.rubric_parts.flatMap((part) =>
      part.rubric_criteria.flatMap((criteria) =>
        criteria.rubric_checks
          .filter((c) => !referencedCheckIds.includes(c.id)) // Don't show already referenced checks
          .map((c) => ({
            value: c.id,
            label: `${c.name} (${c.points} pts)`,
            rubricName: rubric.name,
            reviewRound: rubric.review_round || "General"
          }))
      )
    )
  );

  const handleAddReference = () => {
    if (!selectedCheckOption) {
      toaster.error({
        title: "Error",
        description: "Please select a check to reference."
      });
      return;
    }

    createReference(
      {
        resource: "rubric_check_references",
        values: {
          referencing_rubric_check_id: check.id,
          referenced_rubric_check_id: selectedCheckOption.value,
          class_id: classId
        }
      },
      {
        onSuccess: () => {
          toaster.success({
            title: "Reference Added",
            description: "The rubric check reference has been added successfully."
          });
          setIsAddingReference(false);
          setSelectedCheckOption(undefined);
          refetchReferences();
        },
        onError: (error) => {
          toaster.error({
            title: "Error Adding Reference",
            description: error.message
          });
        }
      }
    );
  };

  const handleDeleteReference = (referenceId: number) => {
    deleteReference(
      { resource: "rubric_check_references", id: referenceId },
      {
        onSuccess: () => {
          toaster.success({
            title: "Reference Removed",
            description: "The reference has been removed successfully."
          });
          refetchReferences();
        },
        onError: (error) => {
          toaster.error({
            title: "Error Removing Reference",
            description: error.message
          });
        }
      }
    );
  };

  const existingReferences = existingReferencesData?.data || [];

  return (
    <Box mt={2}>
      {/* Show existing references */}
      {existingReferences.length > 0 && (
        <VStack gap={1} alignItems="stretch" mb={2}>
          {existingReferences.map((reference) => {
            const referencedCheck = referencedChecks.find((c) => c.id === reference.referenced_rubric_check_id);
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
}

function AddReferencingFeedbackPopover({
  selectedCheckToReference,
  commentToReference,
  close
}: {
  selectedCheckToReference: number;
  commentToReference: SubmissionFileComment | SubmissionComments | SubmissionArtifactComment;
  close: () => void;
}) {
  const [selectedSubOption, setSelectedSubOption] = useState<RubricCheckSubOptions | null>(null);
  const check = useRubricCheck(selectedCheckToReference);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const targetSubmissionReviewId = useWritableSubmissionReviews(check?.criteria?.rubric_id);
  const { mutateAsync: createComment } = useCreate({
    resource: "submission_file_comments"
  });

  return (
    <Popover.Root open={selectedCheckToReference !== undefined} positioning={{ placement: "top" }}>
      <Popover.Trigger></Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content>
            <Popover.Arrow />
            <Popover.Body bg="bg.subtle" p={3} boxShadow="lg">
              <Heading size="md">Add check: {check?.name}</Heading>
              <Markdown>{check?.description}</Markdown>
              {isRubricCheckDataWithOptions(check) && (
                <Select
                  options={check.options.map(
                    (option: RubricCheckSubOption, index: number) =>
                      ({
                        label: option.label,
                        comment: option.label,
                        value: index.toString(),
                        index: index.toString(),
                        points: option.points,
                        check: {
                          label: check.name,
                          value: check.id.toString(),
                          check,
                          criteria: check.criteria,
                          options: []
                        }
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
              {!selectedSubOption && check && check.points !== undefined && (
                <Text fontSize="sm" color="fg.muted" mt={1} textAlign="left">
                  {formatPoints({
                    check,
                    criteria: check.criteria,
                    points: check.points
                  })}
                </Text>
              )}
              {selectedSubOption && check && (
                <Text fontSize="sm" color="fg.muted" mt={1} textAlign="left">
                  {formatPoints({
                    check,
                    criteria: check.criteria,
                    points: selectedSubOption.points
                  })}
                </Text>
              )}
              <MessageInput
                textAreaRef={messageInputRef}
                enableGiphyPicker={true}
                placeholder={
                  !check
                    ? "Add a comment about this line and press enter to submit..."
                    : check.is_comment_required
                      ? "Add a comment about this check and press enter to submit..."
                      : "Optionally add a comment, or just press enter to submit..."
                }
                allowEmptyMessage={check && !check.is_comment_required}
                defaultSingleLine={true}
                sendMessage={async (message, profile_id) => {
                  if (!check || !targetSubmissionReviewId || targetSubmissionReviewId.length === 0) {
                    toaster.error({
                      title: "Error",
                      description: "Cannot save rubric annotation."
                    });
                    return;
                  }
                  let points = check?.points;
                  if (selectedSubOption !== null) {
                    points = selectedSubOption.points;
                  }
                  let comment = message || "";
                  if (selectedSubOption) {
                    comment = selectedSubOption.comment + (comment ? "\n" + comment : "");
                  }

                  const value = {
                    comment,
                    rubric_check_id: check.id,
                    class_id: check.class_id,
                    submission_id: targetSubmissionReviewId[0].submission_id,
                    eventually_visible: false,
                    author: profile_id,
                    released: false,
                    points,
                    submission_review_id: targetSubmissionReviewId[0].id
                  };
                  if (isLineComment(commentToReference)) {
                    await createComment({
                      resource: "submission_file_comments",
                      values: {
                        ...value,
                        line: commentToReference.line,
                        submission_file_id: commentToReference.submission_file_id
                      }
                    });
                  } else if (isArtifactComment(commentToReference)) {
                    await createComment({
                      resource: "submission_artifact_comments",
                      values: {
                        ...value,
                        submission_artifact_id: commentToReference.submission_artifact_id
                      }
                    });
                  } else {
                    await createComment({
                      resource: "submission_comments",
                      values: {
                        ...value
                      }
                    });
                  }
                  close();
                }}
              />
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

function AddReferencingFeedbackMenu({
  comment
}: {
  comment: SubmissionFileComment | SubmissionComments | SubmissionArtifactComment;
}) {
  const writableReferencingChecks = useWritableReferencingRubricChecks(comment.rubric_check_id);
  const rubrics = useRubrics();
  const [selectedCheckToReference, setSelectedCheckToReference] = useState<number | undefined>(undefined);

  const closePopover = useCallback(() => {
    setSelectedCheckToReference(undefined);
  }, []);

  if (!writableReferencingChecks || writableReferencingChecks.length === 0) {
    return null;
  }
  const writableReferencingChecksByRubricId = writableReferencingChecks.reduce(
    (acc, check) => {
      const rubricId = check.criteria?.rubric_id;
      if (rubricId) {
        if (!acc[rubricId]) {
          acc[rubricId] = [];
        }
        acc[rubricId].push(check);
      }
      return acc;
    },
    {} as Record<string, typeof writableReferencingChecks>
  );
  return (
    <>
      {selectedCheckToReference && (
        <AddReferencingFeedbackPopover
          commentToReference={comment}
          selectedCheckToReference={selectedCheckToReference}
          close={closePopover}
        />
      )}
      <Menu.Root
        onSelect={(value) => {
          if (value.value) {
            setSelectedCheckToReference(Number(value.value));
          }
        }}
      >
        <Menu.Trigger asChild>
          <Button p={0} m={0} colorPalette="green" variant="solid" size="2xs">
            <Icon as={FaGraduationCap} />
          </Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content>
              {Object.keys(writableReferencingChecksByRubricId).map((rubricId) => (
                <Menu.ItemGroup key={rubricId}>
                  <Menu.ItemGroupLabel>
                    {rubrics.find((r) => r.id === Number(rubricId))?.review_round}
                  </Menu.ItemGroupLabel>
                  {writableReferencingChecksByRubricId[rubricId].map((check) => (
                    <Menu.Item key={check.check.id} value={check.check.id.toString()}>
                      {check.check.name}{" "}
                      {check.check.points && (
                        <>
                          ({check.criteria?.is_additive ? "+" : "-"}
                          {check.check.points})
                        </>
                      )}
                    </Menu.Item>
                  ))}
                </Menu.ItemGroup>
              ))}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </>
  );
}

export function CommentActions({
  comment,
  setIsEditing
}: {
  comment: SubmissionFileComment | SubmissionComments | SubmissionArtifactComment;
  setIsEditing: (isEditing: boolean) => void;
}) {
  const { private_profile_id } = useClassProfiles();
  const resource = isArtifactComment(comment)
    ? "submission_artifact_comments"
    : isLineComment(comment)
      ? "submission_file_comments"
      : "submission_comments";

  const { mutateAsync: updateComment } = useUpdate({
    resource: resource
  });

  return (
    <HStack gap={1}>
      <AddReferencingFeedbackMenu comment={comment} />
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
  const searchParams = useSearchParams();
  const currentSelectedRubricId = searchParams.get("selected_rubric_id");
  // Use current selected rubric if available, otherwise fall back to comment's rubric check ID
  const rubricIdToUse = currentSelectedRubricId || comment.rubric_check_id?.toString();
  const artifact = submission?.submission_artifacts.find((artifact) => artifact.id === comment.submission_artifact_id);
  if (!artifact || !submission) {
    return <></>;
  }
  const shortFileName = path.basename(artifact.name);

  const baseUrl = linkToSubPage(pathname, "files");
  const queryParams = new URLSearchParams();
  queryParams.set("artifact_id", comment.submission_artifact_id.toString());
  if (rubricIdToUse) {
    queryParams.set("selected_rubric_id", rubricIdToUse);
  }

  return <Link href={`${baseUrl}?${queryParams.toString()}`}>@ {shortFileName}</Link>;
}

export function SubmissionFileCommentLink({ comment }: { comment: SubmissionFileComment }) {
  const submission = useSubmissionMaybe();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentSelectedRubricId = searchParams.get("selected_rubric_id");
  // Use current selected rubric if available, otherwise fall back to comment's rubric check ID
  const rubricIdToUse = currentSelectedRubricId || comment.rubric_check_id?.toString();
  const file = submission?.submission_files.find((file) => file.id === comment.submission_file_id);
  if (!file || !submission) {
    return <></>;
  }
  const shortFileName = path.basename(file.name);

  const baseUrl = linkToSubPage(pathname, "files");
  const queryParams = new URLSearchParams();
  queryParams.set("file_id", comment.submission_file_id.toString());
  if (rubricIdToUse) {
    queryParams.set("selected_rubric_id", rubricIdToUse);
  }

  return (
    <Link href={`${baseUrl}?${queryParams.toString()}#L${comment.line}`}>
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
  criteria?: HydratedRubricCriteria;
  check?: HydratedRubricCheck;
}) {
  const author = useUserProfile(comment.author);
  const [isEditing, setIsEditing] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const submission = useSubmissionMaybe();
  const resource = isArtifactComment(comment)
    ? "submission_artifact_comments"
    : isLineComment(comment)
      ? "submission_file_comments"
      : "submission_comments";

  const { mutateAsync: updateComment } = useUpdate({
    resource: resource
  });
  const pathname = usePathname();

  const handleEditComment = useCallback(
    async (message: string) => {
      await updateComment({
        id: comment.id,
        values: { comment: message }
      });
      setIsEditing(false);
    },
    [updateComment, comment.id, setIsEditing]
  );

  const linkedFileId =
    check?.file && submission ? submission.submission_files.find((f) => f.name === check.file)?.id : undefined;
  const linkedArtifactId =
    check?.artifact && submission
      ? submission.submission_artifacts.find((a) => a.name === check.artifact)?.id
      : undefined;

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
  return (
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
          <Text fontSize="sm" color="fg.muted">
            {author?.name} {criteria ? "applied" : "commented"} {formatRelative(comment.created_at, new Date())}
          </Text>
          <CommentActions comment={comment} setIsEditing={setIsEditing} />
        </HStack>
      </Box>
      <Box pl={1} pr={1} color="fg.muted">
        <HStack gap={1}>
          {pointsText} {isLineComment(comment) && <SubmissionFileCommentLink comment={comment} />}{" "}
          {isArtifactComment(comment) && <SubmissionArtifactCommentLink comment={comment} />}
          {!isLineComment(comment) && !isArtifactComment(comment) && linkedFileId && submission && check?.file && (
            <Link
              href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ file_id: linkedFileId.toString() }).toString()}`}
            >
              {" "}
              (Ref: {check.file})
            </Link>
          )}
          {!isLineComment(comment) &&
            !isArtifactComment(comment) &&
            linkedArtifactId &&
            submission &&
            check?.artifact && (
              <Link
                href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ artifact_id: linkedArtifactId.toString() }).toString()}`}
              >
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
            sendMessage={handleEditComment}
          />
        ) : (
          <Markdown>{comment.comment}</Markdown>
        )}
      </Box>
    </Box>
  );
}

function ReferencedFeedbackHeader({ check_id }: { check_id: number }) {
  const rubricCheck = useRubricCheck(check_id);
  return (
    <Tooltip content={rubricCheck?.description || "No description"} showArrow>
      <Text fontSize="xs" fontWeight="bold" truncate>
        {rubricCheck?.name}
      </Text>
    </Tooltip>
  );
}

export function ReviewRoundTag({ submission_review_id }: { submission_review_id: number }) {
  const submissionReview = useSubmissionReview(submission_review_id);
  if (!submissionReview) {
    return null;
  }
  return (
    <Tag.Root minW="fit-content" flexShrink={0} size="sm" colorPalette="blue" variant="outline">
      <Tag.Label>{submissionReview.rubrics.review_round}</Tag.Label>
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

export function RubricCheckAnnotation({
  check,
  criteria,
  activeSubmissionReviewId,
  assignmentId,
  classId,
  currentRubricId
}: {
  check: HydratedRubricCheck;
  criteria: HydratedRubricCriteria;
  activeSubmissionReviewId?: number;
  assignmentId?: number;
  classId?: number;
  currentRubricId?: number;
}) {
  const rubricCheckComments = useRubricCheckInstances(check as RubricChecks, activeSubmissionReviewId);
  const isGrader = useIsGraderOrInstructor();
  const gradingIsRequired = isGrader && check.is_required && rubricCheckComments.length == 0;
  const annotationTarget = check.annotation_target || "file";
  const submission = useSubmissionMaybe();
  const isPreviewMode = !submission;

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

      {/* Inline reference management for preview mode */}
      {isPreviewMode && assignmentId && classId && currentRubricId && (
        <InlineReferenceManager
          check={check}
          assignmentId={assignmentId}
          classId={classId}
          currentRubricId={currentRubricId}
        />
      )}

      {/* Show referenced feedback for grading mode */}
      {!isPreviewMode && <ReferencedFeedbackDisplay referencing_check_id={check.id} />}
    </Box>
  );
}

export function RubricCheckGlobal({
  check,
  criteria,
  isSelected,
  activeSubmissionReviewId,
  submissionReview,
  assignmentId,
  classId,
  currentRubricId
}: {
  check: HydratedRubricCheck;
  criteria: HydratedRubricCriteria;
  isSelected: boolean;
  activeSubmissionReviewId?: number;
  submissionReview?: SubmissionReview;
  assignmentId?: number;
  classId?: number;
  currentRubricId?: number;
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
  const isPreviewMode = !submission;
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
  const hasOptions = isRubricCheckDataWithOptions(check.data) && check.data.options.length > 0;
  const showOptions = isGrader && hasOptions;
  const _selectedOptionIndex =
    hasOptions && rubricCheckComments.length == 1 && isRubricCheckDataWithOptions(check.data)
      ? check.data.options.findIndex((option: RubricCheckSubOption) => option.points === rubricCheckComments[0].points)
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
              <Link
                href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ file_id: linkedFileId.toString() }).toString()}`}
              >
                File: {check.file}
              </Link>
            )}
            {linkedAritfactId && submission && (
              <Link
                href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ artifact_id: linkedAritfactId.toString() }).toString()}`}
              >
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
                if (isRubricCheckDataWithOptions(check.data)) {
                  const selectedOption = check.data.options[parseInt(value.value)];
                  if (selectedOption) {
                    setSelectedOptionIndex(parseInt(value.value));
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
                href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ file_id: linkedFileId.toString() }).toString()}`}
              >
                File: {check.file}
              </Link>
            )}
            {linkedAritfactId && submission && (
              <Link
                href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ artifact_id: linkedAritfactId.toString() }).toString()}`}
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
                <Link
                  href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ file_id: linkedFileId.toString() }).toString()}`}
                >
                  {" "}
                  (File: {check.file})
                </Link>
              )}
              {linkedAritfactId && submission && (
                <Link
                  href={`${linkToSubPage(pathname, "files")}?${new URLSearchParams({ artifact_id: linkedAritfactId.toString() }).toString()}`}
                >
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

      {/* Inline reference management for preview mode */}
      {isPreviewMode && assignmentId && classId && currentRubricId && (
        <InlineReferenceManager
          check={check}
          assignmentId={assignmentId}
          classId={classId}
          currentRubricId={currentRubricId}
        />
      )}

      {/* Show referenced feedback for grading mode */}
      {!isPreviewMode && <ReferencedFeedbackDisplay referencing_check_id={check.id} />}
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
  const resource =
    check.is_annotation && check.annotation_target === "artifact"
      ? "submission_artifact_comments"
      : check.is_annotation
        ? "submission_file_comments"
        : "submission_comments";

  const { mutateAsync: createComment } = useCreate({
    resource: resource
  });

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
  submissionReview,
  assignmentId,
  classId,
  currentRubricId
}: {
  criteria: HydratedRubricCriteria;
  check: HydratedRubricCheck;
  isSelected: boolean;
  activeSubmissionReviewId?: number;
  submissionReview?: SubmissionReview;
  assignmentId?: number;
  classId?: number;
  currentRubricId?: number;
}) {
  return (
    <Box p={1} w="100%">
      {check.is_annotation ? (
        <RubricCheckAnnotation
          check={check}
          criteria={criteria}
          activeSubmissionReviewId={activeSubmissionReviewId}
          assignmentId={assignmentId}
          classId={classId}
          currentRubricId={currentRubricId}
        />
      ) : (
        <RubricCheckGlobal
          check={check}
          criteria={criteria}
          isSelected={isSelected}
          activeSubmissionReviewId={activeSubmissionReviewId}
          submissionReview={submissionReview}
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
  activeSubmissionReviewId,
  submissionReview,
  assignmentId,
  classId,
  currentRubricId
}: {
  criteria: HydratedRubricCriteria;
  activeSubmissionReviewId?: number;
  submissionReview?: SubmissionReview;
  assignmentId?: number;
  classId?: number;
  currentRubricId?: number;
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
              assignmentId={assignmentId}
              classId={classId}
              currentRubricId={currentRubricId}
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
  submissionReview,
  assignmentId,
  classId,
  currentRubricId
}: {
  part: HydratedRubricPart;
  activeSubmissionReviewId?: number;
  submissionReview?: SubmissionReview;
  assignmentId?: number;
  classId?: number;
  currentRubricId?: number;
}) {
  return (
    <Box>
      <Heading size="md">{part.name}</Heading>
      <Markdown>{part.description}</Markdown>
      <VStack align="start" w="100%" gap={2}>
        {part.rubric_criteria
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((criteria, index) => (
            <RubricCriteria
              key={`criteria-${criteria.id}-${index}`}
              criteria={criteria}
              activeSubmissionReviewId={activeSubmissionReviewId}
              submissionReview={submissionReview}
              assignmentId={assignmentId}
              classId={classId}
              currentRubricId={currentRubricId}
            />
          ))}
      </VStack>
    </Box>
  );
}

export default function RubricSidebar({
  initialRubric,
  reviewAssignmentId,
  submissionReview,
  assignmentId,
  classId
}: {
  initialRubric?: HydratedRubric;
  reviewAssignmentId?: number;
  submissionReview?: SubmissionReview;
  assignmentId?: number;
  classId?: number;
}) {
  const {
    reviewAssignment,
    isLoading: isLoadingReviewAssignment,
    error: reviewAssignmentErrorObj
  } = useReviewAssignment(reviewAssignmentId);

  const { rubric: fetchedRubricFromHook, isLoading: isLoadingFetchedRubricFromHook } =
    useSubmissionRubric(reviewAssignmentId);

  const displayRubric = !reviewAssignmentId && initialRubric ? initialRubric : fetchedRubricFromHook;
  const isLoadingEffectiveRubric = !reviewAssignmentId && initialRubric ? false : isLoadingFetchedRubricFromHook;

  const isLoading = isLoadingEffectiveRubric || (reviewAssignmentId && isLoadingReviewAssignment);

  const combinedError = reviewAssignmentId ? reviewAssignmentErrorObj : null;

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
        .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    } else if (displayRubric.rubric_parts) {
      partsToDisplay = [...displayRubric.rubric_parts].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    }
  }

  if (isLoading) {
    return (
      <Box p={2} minW="md" maxW="lg" key="loading-sidebar">
        <Skeleton height="100vh" />
      </Box>
    );
  }

  if (combinedError) {
    return (
      <Box p={2} key="error-sidebar">
        <Text color="red.500">Error loading review details: {combinedError.message}</Text>
      </Box>
    );
  }

  if (!displayRubric) {
    return (
      <Box p={2} minW="md" maxW="lg" key="no-rubric-sidebar">
        <Text>No rubric information available.</Text>
      </Box>
    );
  }

  if (partsToDisplay.length === 0) {
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
        key="empty-parts-sidebar"
      >
        <VStack align="start" w="100%">
          <Heading size="xl">Grading Rubric</Heading>
          <Text fontSize="lg" fontWeight="semibold">
            {displayRubric.name}
          </Text>
          {displayRubric.description && <Markdown>{displayRubric.description}</Markdown>}
          <Text mt={2}>This rubric is empty.</Text>
        </VStack>
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
        <Text fontSize="lg" fontWeight="semibold">
          {displayRubric.name}
        </Text>
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
            assignmentId={assignmentId}
            classId={classId}
            currentRubricId={displayRubric?.id}
          />
        ))}
      </VStack>
    </Box>
  );
}
