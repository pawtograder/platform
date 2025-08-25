"use client";

import {
  useMyReviewAssignments,
  useReviewAssignment,
  useReviewAssignmentRubricParts,
  useRubricById,
  useRubrics,
  useSelfReviewSettings
} from "@/hooks/useAssignment";
import {
  Box,
  Button,
  Heading,
  HStack,
  Icon,
  List,
  Popover,
  SegmentGroup,
  Skeleton,
  Text,
  VStack
} from "@chakra-ui/react";

import { useClassProfiles, useIsStudent } from "@/hooks/useClassProfiles";
import { useCourse } from "@/hooks/useCourseController";
import {
  useAllCommentsForReview,
  useSubmission,
  useSubmissionController,
  useSubmissionReview,
  useWritableSubmissionReviews
} from "@/hooks/useSubmission";
import {
  useActiveReviewAssignmentId,
  useActiveSubmissionReview,
  useActiveSubmissionReviewId,
  useIgnoreAssignedReview,
  useMissingRubricChecksForActiveReview,
  useSetActiveSubmissionReviewId,
  useSetIgnoreAssignedReview
} from "@/hooks/useSubmissionReview";
import { formatDueDateInTimezone } from "@/lib/utils";
import { createClient } from "@/utils/supabase/client";
import { formatDate } from "date-fns";
import { useCallback, useMemo, useState } from "react";
import { FaRegCheckCircle } from "react-icons/fa";
import PersonName from "./person-name";
import SelfReviewDueDateInformation from "./self-review-due-date-information";
import { Toaster, toaster } from "./toaster";

function ActiveReviewPicker() {
  const activeSubmissionReviewId = useActiveSubmissionReviewId();
  const writableSubmissionReviews = useWritableSubmissionReviews();
  const setActiveSubmissionReviewId = useSetActiveSubmissionReviewId();
  const rubrics = useRubrics();
  if (activeSubmissionReviewId && !writableSubmissionReviews?.find((wr) => wr.id === activeSubmissionReviewId)) {
    return <Skeleton />;
  }
  return (
    <HStack gap={2}>
      <Text>Select a review to work on:</Text>
      <SegmentGroup.Root
        value={activeSubmissionReviewId?.toString() ?? ""}
        onValueChange={(value) => {
          const selectedId = Number(value.value);
          setActiveSubmissionReviewId(selectedId);
        }}
      >
        <SegmentGroup.Indicator />
        {writableSubmissionReviews?.map((review) => (
          <SegmentGroup.Item key={review.id} value={review.id.toString()}>
            <SegmentGroup.ItemText>{rubrics.find((r) => r.id === review.rubric_id)?.name}</SegmentGroup.ItemText>
            <SegmentGroup.ItemHiddenInput />
          </SegmentGroup.Item>
        ))}
      </SegmentGroup.Root>
    </HStack>
  );
}

/**
 * Hook to check missing rubric checks for a specific review assignment.
 * Only checks the rubric parts assigned to the review assignment, not the entire rubric.
 */
function useMissingRubricChecksForReviewAssignment(reviewAssignmentId?: number) {
  const reviewAssignment = useReviewAssignment(reviewAssignmentId);
  const reviewAssignmentRubricParts = useReviewAssignmentRubricParts(reviewAssignmentId);
  const activeSubmissionReview = useActiveSubmissionReview();
  const comments = useAllCommentsForReview(activeSubmissionReview?.id);
  const rubric = useRubricById(reviewAssignment?.rubric_id);

  const assignedRubricPartIds = reviewAssignmentRubricParts.map((part) => part.rubric_part_id);

  const rubricChecksForAssignedParts = useMemo(() => {
    if (!rubric) return [];

    return rubric.rubric_parts
      .filter(
        (part) =>
          !assignedRubricPartIds || assignedRubricPartIds.length === 0 || assignedRubricPartIds.includes(part.id)
      )
      .flatMap((part) => part.rubric_criteria.flatMap((criteria) => criteria.rubric_checks));
  }, [rubric, assignedRubricPartIds]);

  const { missing_required_checks, missing_optional_checks } = useMemo(() => {
    return {
      missing_required_checks: rubricChecksForAssignedParts?.filter(
        (check) => check.is_required && !comments.some((comment) => comment.rubric_check_id === check.id)
      ),
      missing_optional_checks: rubricChecksForAssignedParts?.filter(
        (check) => !check.is_required && !comments.some((comment) => comment.rubric_check_id === check.id)
      )
    };
  }, [rubricChecksForAssignedParts, comments]);

  const { missing_required_criteria, missing_optional_criteria } = useMemo(() => {
    if (!rubric || assignedRubricPartIds.length === 0) {
      return { missing_required_criteria: [], missing_optional_criteria: [] };
    }

    const assignedCriteria = rubric.rubric_parts
      .filter((part) => assignedRubricPartIds.includes(part.id))
      .flatMap((part) => part.rubric_criteria);

    const criteriaEvaluation = assignedCriteria?.map((criteria) => ({
      criteria,
      check_count_applied: criteria.rubric_checks.filter((check) =>
        comments.some((comment) => comment.rubric_check_id === check.id)
      ).length
    }));
    return {
      missing_required_criteria: criteriaEvaluation?.filter(
        (item) =>
          item.criteria.min_checks_per_submission !== null &&
          item.check_count_applied < item.criteria.min_checks_per_submission
      ),
      missing_optional_criteria: criteriaEvaluation?.filter(
        (item) => item.criteria.min_checks_per_submission === null && item.check_count_applied === 0
      )
    };
  }, [comments, rubric, assignedRubricPartIds]);

  return { missing_required_checks, missing_optional_checks, missing_required_criteria, missing_optional_criteria };
}

/**
 * Dialog content for completing a review assignment.
 */
function CompleteReviewAssignmentDialog({
  reviewAssignment,
  missing_required_checks,
  missing_required_criteria,
  isLoading,
  setIsLoading
}: {
  reviewAssignment: {
    id: number;
  };
  missing_required_checks: {
    id: number;
    name: string;
  }[];
  missing_required_criteria: {
    criteria: {
      id: number;
      name: string;
      min_checks_per_submission: number | null;
    };
    check_count_applied: number;
  }[];
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}) {
  const { private_profile_id } = useClassProfiles();

  return (
    <Popover.Content>
      <Popover.Header>
        <Heading size="sm">Complete Review Assignment</Heading>
      </Popover.Header>
      <Popover.Body>
        <VStack alignItems="flex-start" gap={2}>
          {missing_required_checks.length > 0 && (
            <VStack alignItems="flex-start" gap={1}>
              <Text fontSize="sm" fontWeight="medium" color="fg.error">
                Missing Required Checks ({missing_required_checks.length}):
              </Text>
              <List.Root variant="plain">
                {missing_required_checks.map((check) => (
                  <List.Item key={check.id}>
                    <List.Indicator asChild>
                      <Icon>
                        <FaRegCheckCircle />
                      </Icon>
                    </List.Indicator>
                    {check.name}
                  </List.Item>
                ))}
              </List.Root>
            </VStack>
          )}
          {missing_required_criteria.length > 0 && (
            <VStack alignItems="flex-start" gap={1}>
              <Text fontSize="sm" fontWeight="medium" color="fg.error">
                Incomplete Required Criteria ({missing_required_criteria.length}):
              </Text>
              <List.Root variant="plain">
                {missing_required_criteria.map((item) => (
                  <List.Item key={item.criteria.id}>
                    <List.Indicator asChild>
                      <Icon>
                        <FaRegCheckCircle />
                      </Icon>
                    </List.Indicator>
                    {item.criteria.name} (need {item.criteria.min_checks_per_submission}, have{" "}
                    {item.check_count_applied})
                  </List.Item>
                ))}
              </List.Root>
            </VStack>
          )}
          {missing_required_checks.length > 0 && (
            <Text fontSize="sm" color="fg.error">
              You must complete all required checks and criteria before marking this review assignment as complete.
            </Text>
          )}
          {missing_required_checks.length == 0 && (
            <Button
              variant="solid"
              colorPalette="green"
              loading={isLoading}
              onClick={async () => {
                try {
                  setIsLoading(true);
                  const supabase = createClient();
                  const { error } = await supabase
                    .from("review_assignments")
                    .update({
                      completed_at: new Date().toISOString(),
                      completed_by: private_profile_id
                    })
                    .eq("id", reviewAssignment.id);

                  if (error) {
                    throw error;
                  }

                  toaster.success({
                    title: "Review assignment marked as complete",
                    description: "Your review assignment has been marked as complete."
                  });
                } catch (error) {
                  console.error("Error marking review assignment as complete", error);
                  toaster.error({
                    title: "Error marking review assignment as complete",
                    description: "An error occurred while marking the review assignment as complete."
                  });
                } finally {
                  setIsLoading(false);
                }
              }}
            >
              Mark Review Assignment as Complete
            </Button>
          )}
        </VStack>
      </Popover.Body>
    </Popover.Content>
  );
}

/**
 * Renders a button and popover interface for marking the active review assignment as complete.
 * Only checks the rubric parts assigned to the review assignment.
 */
export function CompleteReviewAssignmentButton() {
  const activeReviewAssignmentId = useActiveReviewAssignmentId();
  const reviewAssignment = useReviewAssignment(activeReviewAssignmentId);
  const { missing_required_checks, missing_optional_checks, missing_required_criteria, missing_optional_criteria } =
    useMissingRubricChecksForReviewAssignment(activeReviewAssignmentId);
  const [isLoading, setIsLoading] = useState(false);

  if (
    !reviewAssignment ||
    !missing_required_checks ||
    !missing_optional_checks ||
    !missing_required_criteria ||
    !missing_optional_criteria ||
    reviewAssignment.completed_at
  ) {
    // Render a loading state or disabled button if already completed
    return (
      <Button variant="surface" loading={!reviewAssignment?.completed_at}>
        {reviewAssignment?.completed_at ? "Review Assignment Completed" : "Complete Review Assignment"}
      </Button>
    );
  }

  return (
    <Popover.Root lazyMount>
      <Popover.Trigger asChild>
        <Button variant="surface" colorPalette="green">
          Complete Review Assignment
        </Button>
      </Popover.Trigger>
      <Popover.Positioner>
        <CompleteReviewAssignmentDialog
          reviewAssignment={reviewAssignment}
          missing_required_checks={missing_required_checks}
          missing_required_criteria={missing_required_criteria}
          isLoading={isLoading}
          setIsLoading={setIsLoading}
        />
      </Popover.Positioner>
    </Popover.Root>
  );
}

/**
 * Renders a button and popover interface for marking the active submission review as complete.
 *
 * Displays missing required and optional rubric checks and criteria, and prevents completion until all required checks are addressed. On completion, updates the review status and shows a success or error notification.
 */
export function CompleteReviewButton() {
  const submissionController = useSubmissionController();
  const { private_profile_id } = useClassProfiles();
  const { missing_required_checks, missing_optional_checks, missing_required_criteria, missing_optional_criteria } =
    useMissingRubricChecksForActiveReview();
  const activeSubmissionReview = useActiveSubmissionReview();
  const [isLoading, setIsLoading] = useState(false);

  if (
    !activeSubmissionReview ||
    !missing_required_checks ||
    !missing_optional_checks ||
    !missing_required_criteria ||
    !missing_optional_criteria
  ) {
    // Render a loading state or disabled button
    return (
      <Button variant="surface" loading>
        Complete Review
      </Button>
    );
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="surface" colorPalette="green">
          Complete Review <Icon as={FaRegCheckCircle} />
        </Button>
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content>
          <Toaster />
          <Popover.Arrow>
            <Popover.ArrowTip />
          </Popover.Arrow>
          <Popover.Body
            bg={
              missing_required_checks.length > 0
                ? "bg.error"
                : missing_optional_checks.length > 0
                  ? "bg.warning"
                  : "bg.success"
            }
            borderRadius="md"
          >
            <VStack align="start">
              <Box w="100%">
                <Heading size="md">
                  {missing_required_checks.length > 0
                    ? "Required Checks Missing"
                    : missing_optional_checks.length > 0
                      ? "Confirm that you have carefully reviewed the submission"
                      : "Complete Review"}
                </Heading>
              </Box>
              {missing_required_checks.length > 0 && (
                <Box>
                  <Heading size="sm">
                    These checks are required. Please apply them before marking the review as done.
                  </Heading>
                  <List.Root as="ol">
                    {missing_required_checks.map((check) => (
                      <List.Item key={check.id}>{check.name}</List.Item>
                    ))}
                    {missing_required_criteria.map((criteria) => (
                      <List.Item key={criteria.criteria.id}>
                        {criteria.criteria.name} (select at least {criteria.criteria.min_checks_per_submission} checks)
                      </List.Item>
                    ))}
                  </List.Root>
                </Box>
              )}
              {missing_optional_checks.length > 0 && (
                <Box>
                  <Heading size="sm">
                    These checks were not applied, but not required. Please take a quick look to make sure that you did
                    not miss anything:
                  </Heading>
                  <List.Root as="ol">
                    {missing_optional_checks.map((check) => (
                      <List.Item key={check.id}>{check.name}</List.Item>
                    ))}
                    {missing_optional_criteria.map((criteria) => (
                      <List.Item key={criteria.criteria.id}>
                        {criteria.criteria.name} (select at least {criteria.criteria.min_checks_per_submission} checks)
                      </List.Item>
                    ))}
                  </List.Root>
                </Box>
              )}
              {missing_required_checks.length == 0 && missing_optional_checks.length == 0 && (
                <Text>All checks have been applied. Click the button below to mark the review as complete.</Text>
              )}
              {missing_required_checks.length == 0 && (
                <Button
                  variant="solid"
                  colorPalette="green"
                  loading={isLoading}
                  onClick={async () => {
                    if (!activeSubmissionReview) {
                      toaster.error({
                        title: "Error marking review as complete",
                        description: "No active submission review found."
                      });
                      return;
                    }
                    try {
                      setIsLoading(true);
                      await submissionController.submission_reviews.update(activeSubmissionReview.id, {
                        completed_at: new Date().toISOString(),
                        completed_by: private_profile_id
                      });
                      toaster.success({
                        title: "Review marked as complete",
                        description: "Your review has been marked as complete."
                      });
                    } catch (error) {
                      console.error("Error marking review as complete", error);
                      toaster.error({
                        title: "Error marking review as complete",
                        description: "An error occurred while marking the review as complete."
                      });
                    } finally {
                      setIsLoading(false);
                    }
                  }}
                >
                  Mark as Complete
                </Button>
              )}
            </VStack>
          </Popover.Body>
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  );
}

function ReviewAssignmentActions() {
  /**
   * Shows options for the active submission review
   * If there is an ASSIGNED review, it will show the due date, too
   */
  const activeReviewAssignmentId = useActiveReviewAssignmentId();
  const activeSubmissionReview = useActiveSubmissionReview();

  const ignoreAssignedReview = useIgnoreAssignedReview();
  const activeReviewAssignment = useReviewAssignment(activeReviewAssignmentId);

  const assignedRubricParts = useReviewAssignmentRubricParts(activeReviewAssignmentId);
  const setIgnoreAssignedReview = useSetIgnoreAssignedReview();

  const rubric = useRubricById(activeReviewAssignment?.rubric_id);
  const { time_zone } = useCourse();
  console.log("assignedRubricParts", assignedRubricParts);
  const rubricPartsAdvice = useMemo(() => {
    return assignedRubricParts
      .map((part) => rubric?.rubric_parts.find((p) => p.id === part.rubric_part_id)?.name)
      .join(", ");
  }, [assignedRubricParts, rubric]); // rubric is not needed, but it's a dependency to force a re-render when the rubric changes

  const leaveReviewAssignment = useCallback(() => {
    setIgnoreAssignedReview(true);
  }, [setIgnoreAssignedReview]);
  const returnToReviewAssignment = useCallback(() => {
    setIgnoreAssignedReview(false);
  }, [setIgnoreAssignedReview]);

  const isStudent = useIsStudent();

  // If there's no active review assignment, don't show assignment-specific actions
  if ((!activeReviewAssignment && !ignoreAssignedReview) || !activeSubmissionReview) {
    return <></>;
  }

  // If the review assignment is already completed, don't show actions
  if (isStudent && activeReviewAssignment && activeReviewAssignment.completed_at) {
    return <></>;
  }

  return (
    <HStack w="100%" alignItems="center" justifyContent="space-between">
      {activeReviewAssignment && (
        <Box>
          <Text textAlign="left">
            Your {rubric?.name} review {rubricPartsAdvice ? `(on ${rubricPartsAdvice})` : ""} is required on this
            submission by{" "}
            {formatDueDateInTimezone(activeReviewAssignment.due_date, time_zone || "America/New_York", false, true)}.
          </Text>
          {!ignoreAssignedReview && (
            <Text textAlign="left" fontSize="sm" color="fg.muted">
              When you are done, click &quot;Complete Review Assignment&quot;.
            </Text>
          )}
          {ignoreAssignedReview && (
            <Text textAlign="left" fontSize="sm" color="fg.muted">
              You are ignoring this review assignment, and viewing the full rubric. You can return to your assignment to
              complete it by clicking &quot;Return to Assigned Review&quot;.
            </Text>
          )}
        </Box>
      )}
      <HStack gap={2}>
        {activeReviewAssignment && rubricPartsAdvice && !ignoreAssignedReview && (
          <Button variant="ghost" colorPalette="gray" onClick={leaveReviewAssignment}>
            View + Grade Full Rubric
          </Button>
        )}
        {ignoreAssignedReview && (
          <Button variant="surface" colorPalette="blue" onClick={returnToReviewAssignment}>
            Return to Assigned Review
          </Button>
        )}
        {activeSubmissionReview && !ignoreAssignedReview && activeReviewAssignment && (
          <CompleteReviewAssignmentButton />
        )}
      </HStack>
    </HStack>
  );
}

function AssignedReviewHistory({ review_assignment_id }: { review_assignment_id: number }) {
  const reviewAssignment = useReviewAssignment(review_assignment_id);
  const submissionReview = useSubmissionReview(reviewAssignment?.submission_review_id);
  const rubric = useRubricById(reviewAssignment?.rubric_id);
  if (
    !reviewAssignment ||
    !submissionReview ||
    !submissionReview.completed_at ||
    !rubric ||
    !submissionReview.completed_by
  ) {
    return <></>;
  }
  return (
    <Text>
      {rubric.name} completed on {formatDate(submissionReview?.completed_at, "MM/dd/yyyy hh:mm a")} by{" "}
      <PersonName uid={submissionReview.completed_by} showAvatar={false} />
    </Text>
  );
}

function CompletedReviewHistory() {
  const submission = useSubmission();
  const myAssignedReviews = useMyReviewAssignments(submission?.id);
  return (
    <>
      {myAssignedReviews.map((ra) => {
        return <AssignedReviewHistory key={ra.id} review_assignment_id={ra.id} />;
      })}
    </>
  );
}

export default function SubmissionReviewToolbar() {
  const writableReviews = useWritableSubmissionReviews();
  const selfReviewSettings = useSelfReviewSettings();
  const activeReviewAssignmentId = useActiveReviewAssignmentId();
  const isStudent = useIsStudent();
  const ignoreAssignedReview = useIgnoreAssignedReview();
  const canSubmitEarlyForSelfReview = selfReviewSettings.enabled && selfReviewSettings.allow_early && isStudent;

  // Check if there's an active, incomplete review assignment
  const activeReviewAssignment = useReviewAssignment(activeReviewAssignmentId);
  const hasActiveIncompleteReview = activeReviewAssignment && !activeReviewAssignment.completed_at;

  if (
    !ignoreAssignedReview &&
    (!writableReviews || writableReviews.length === 0 || writableReviews.length === 1) &&
    !canSubmitEarlyForSelfReview &&
    !activeReviewAssignmentId
  ) {
    return <></>;
  }

  return (
    <Box
      w="100%"
      p={2}
      borderRadius="md"
      borderWidth="1px"
      borderColor="border.info"
      bg="bg.info"
      data-visual-test-no-radius
    >
      <SelfReviewDueDateInformation />
      <HStack w="100%" justifyContent="space-between">
        {writableReviews && writableReviews.length > 1 && <ActiveReviewPicker />}
        <ReviewAssignmentActions />
      </HStack>
      {/* Only show completed history when NOT actively working on another review */}
      {!hasActiveIncompleteReview && <CompletedReviewHistory />}
    </Box>
  );
}
