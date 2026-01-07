"use client";
import FinalizeSubmissionEarly from "@/app/course/[course_id]/assignments/[assignment_id]/finalizeSubmissionEarly";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { useMyReviewAssignments, useRubric } from "@/hooks/useAssignment";
import { useAssignmentDueDate, useAssignmentGroupForUser } from "@/hooks/useCourseController";
import { Assignment, SelfReviewSettings, Submission, SubmissionReview, UserRole } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex, Heading, Skeleton, Text, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { addHours, differenceInMinutes } from "date-fns";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { FaExclamationTriangle } from "react-icons/fa";

function CompleteReviewButton({
  assignment,
  enrollment,
  activeSubmission
}: {
  assignment: Assignment;
  enrollment: UserRole;
  activeSubmission: Submission;
}) {
  const { course_id, assignment_id } = useParams();
  const { data: reviewSubmissions } = useList<SubmissionReview>({
    resource: "submission_reviews",
    filters: [
      { field: "class_id", operator: "eq", value: assignment.class_id },
      { field: "completed_by", operator: "eq", value: enrollment.private_profile_id },
      { field: "submission_id", operator: "eq", value: activeSubmission?.id }
    ]
  });
  const reviewAssignments = useMyReviewAssignments();
  const selfReviewRubric = useRubric("self-review");
  const selfReviewAssignment = reviewAssignments.find((a) => a.rubric_id === selfReviewRubric?.id);

  return (
    <>
      {!reviewSubmissions || reviewSubmissions?.data.length == 0 ? (
        <Link
          href={`/course/${course_id}/assignments/${assignment_id}/submissions/${selfReviewAssignment?.submission_id}/files?review_assignment_id=${selfReviewAssignment?.id}`}
        >
          <Button colorPalette="green" variant="surface">
            Complete Self Review
          </Button>
        </Link>
      ) : (
        <Flex>You have already submitted your review for this assignment.</Flex>
      )}
    </>
  );
}

function SelfReviewNoticeInner({
  review_settings,
  assignment,
  enrollment,
  activeSubmission
}: {
  review_settings: SelfReviewSettings;
  assignment: Assignment;
  enrollment: UserRole;
  activeSubmission?: Submission;
}) {
  const ourAssignmentGroup = useAssignmentGroupForUser({ assignment_id: assignment.id });
  const { dueDate } = useAssignmentDueDate(assignment, {
    studentPrivateProfileId: enrollment.private_profile_id,
    assignmentGroupId: ourAssignmentGroup?.id
  });
  const myReviewAssignments = useMyReviewAssignments();
  const selfReviewRubric = useRubric("self-review");
  const selfReviewAssignment = myReviewAssignments.find((a) => a.rubric_id === selfReviewRubric?.id);
  const [isLoading, setIsLoading] = useState(false);

  function deadlinePassed(): boolean {
    if (dueDate) {
      return differenceInMinutes(Date.now(), dueDate) > 0;
    }
    return false;
  }

  const canFinalizeEarly = !deadlinePassed() && activeSubmission !== undefined;

  if (!dueDate || !review_settings) {
    return <Skeleton height="20px" width="80px" />;
  }

  const evalDeadline = addHours(dueDate, review_settings.deadline_offset ?? 0);

  return (
    <>
      {selfReviewAssignment ? (
        <VStack gap="1" alignItems="flex-start" w="100%">
          <Flex alignItems="center" gap="2">
            <FaExclamationTriangle />
            <Heading size="md">Self Review Now Due</Heading>
            <Text fontSize="sm" color="fg.muted">
              Due by <TimeZoneAwareDate date={evalDeadline} format="MMM d, h:mm a" />
            </Text>
          </Flex>
          <Flex
            mt="2"
            w="100%"
            justifyContent={"space-between"}
            alignItems={"center"}
            flexDir={{ base: "column", md: "row" }}
          >
            <Text fontSize="sm" color="fg.muted">
              To complete your self review assignment, press the button below and answer a few short questions about
              your implementation.
            </Text>
            {activeSubmission && (
              <CompleteReviewButton
                assignment={assignment}
                enrollment={enrollment}
                activeSubmission={activeSubmission}
              />
            )}
          </Flex>
        </VStack>
      ) : review_settings?.enabled ? (
        <VStack gap="1" alignItems="flex-start" w="100%">
          <Flex alignItems="center" gap="2">
            <FaExclamationTriangle />
            <Heading size="md">Self Review Notice</Heading>
          </Flex>
          <Text fontSize="sm" color="fg.muted">
            There is a self review scheduled on this assignment which will release immediately after your deadline
            passes and will be <strong>due {review_settings?.deadline_offset} hours later.</strong>
          </Text>
          {review_settings && review_settings.allow_early && (
            <Flex
              mt="2"
              w="100%"
              justifyContent={"space-between"}
              alignItems={"center"}
              flexDir={{ base: "column", md: "row" }}
            >
              <Text fontSize="sm" color="fg.muted">
                If you are done with your submission, you can finalize it early to be able to submit your self-review
                early.
              </Text>
              <FinalizeSubmissionEarly
                assignment={assignment}
                private_profile_id={enrollment?.private_profile_id}
                enabled={canFinalizeEarly ?? false}
                setLoading={setIsLoading}
                loading={isLoading}
              />
            </Flex>
          )}
        </VStack>
      ) : (
        <></>
      )}
    </>
  );
}

export default function SelfReviewNotice(props: {
  review_settings: SelfReviewSettings;
  assignment: Assignment;
  enrollment: UserRole;
  activeSubmission?: Submission;
}) {
  if (!props.review_settings.enabled) {
    return <></>;
  }
  return (
    <Box m={4} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle" maxW="4xl">
      <SelfReviewNoticeInner {...props} />
    </Box>
  );
}
