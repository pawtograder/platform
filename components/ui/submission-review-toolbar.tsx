"use client";

import {
  useMyReviewAssignments,
  useReviewAssignment,
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

import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourse } from "@/hooks/useCourseController";
import {
  useSubmission,
  useSubmissionController,
  useSubmissionReview,
  useWritableSubmissionReviews
} from "@/hooks/useSubmission";
import {
  useActiveReviewAssignmentId,
  useActiveSubmissionReview,
  useActiveSubmissionReviewId,
  useMissingRubricChecksForActiveReview,
  useSetActiveSubmissionReviewId
} from "@/hooks/useSubmissionReview";
import { formatDueDateInTimezone } from "@/lib/utils";
import { formatDate } from "date-fns";
import { useState } from "react";
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
          setActiveSubmissionReviewId(Number(value.value));
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
              {missing_required_checks.length == 0 && missing_optional_checks.length == 0 && (
                <Button
                  variant="solid"
                  colorPalette="green"
                  loading={isLoading}
                  onClick={async () => {
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
  const activeReviewAssignment = useReviewAssignment(activeReviewAssignmentId);
  const { time_zone } = useCourse();
  const rubric = useRubricById(activeSubmissionReview?.rubric_id);
  if (!activeReviewAssignment || !activeSubmissionReview || activeSubmissionReview.completed_at) {
    return <></>;
  }
  return (
    <HStack w="100%" alignItems="center" justifyContent="space-between">
      {activeReviewAssignment && (
        <Text textAlign="left">
          Your {rubric?.name} review is required by{" "}
          {formatDueDateInTimezone(activeReviewAssignment.due_date, time_zone || "America/New_York", false, true)}. When
          you are done, click &quot;Complete Review&quot;.
        </Text>
      )}
      {activeSubmissionReview && activeReviewAssignment && <CompleteReviewButton />}
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
  const canSubmitEarlyForSelfReview = selfReviewSettings.enabled && selfReviewSettings.allow_early;
  if (
    (!writableReviews || writableReviews.length === 0 || writableReviews.length === 1) &&
    !canSubmitEarlyForSelfReview &&
    !activeReviewAssignmentId
  ) {
    return <></>;
  }
  return (
    <Box w="100%" p={2} borderRadius="md" borderWidth="1px" borderColor="border.info" bg="bg.info">
      <SelfReviewDueDateInformation /> {/* TODO: This is not working */}
      <HStack w="100%" justifyContent="space-between">
        {writableReviews && writableReviews.length > 1 && <ActiveReviewPicker />}
        <ReviewAssignmentActions /> {/* TODO: This is not showing up */}
      </HStack>
      <CompletedReviewHistory />
    </Box>
  );
}
