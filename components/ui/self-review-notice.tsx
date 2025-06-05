"use client";
import { AssignmentProvider, useMyReviewAssignments, useRubric } from "@/hooks/useAssignment";
import { useAssignmentDueDate } from "@/hooks/useCourseController";
import { Assignment, SelfReviewSettings, Submission, SubmissionReview, UserRole } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex, Heading, Skeleton, Text } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useList } from "@refinedev/core";
import { addHours } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useParams, useRouter } from "next/navigation";
import { FaExclamationTriangle } from "react-icons/fa";

// Inner component that uses the assignment context
function SelfReviewNoticeInner({
  review_settings,
  assignment,
  enrollment,
  activeSubmission
}: {
  review_settings: SelfReviewSettings;
  assignment: Assignment;
  enrollment: UserRole;
  activeSubmission: Submission | undefined;
}) {
  const router = useRouter();
  const { course_id, assignment_id } = useParams();

  const { data: reviewSubmissions } = useList<SubmissionReview>({
    resource: "submission_reviews",
    filters: [
      { field: "class_id", operator: "eq", value: assignment.class_id },
      { field: "completed_by", operator: "eq", value: enrollment?.private_profile_id },
      { field: "submission_id", operator: "eq", value: activeSubmission?.id }
    ]
  });

  // These hooks now work because they're inside AssignmentProvider
  const reviewassignments = useMyReviewAssignments();
  const selfReviewRubric = useRubric("self-review");
  const selfReviewAssignment = reviewassignments.find((a) => a.rubric_id === selfReviewRubric?.id);

  const { dueDate, time_zone } = useAssignmentDueDate(assignment);

  if (!dueDate || !review_settings) {
    return <Skeleton height="20px" width="80px" />;
  }

  const evalDeadline = addHours(dueDate, review_settings.deadline_offset ?? 0);

  return (
    <>
      {new TZDate(dueDate, time_zone) < new TZDate(new Date(), time_zone) ? ( // less than now
        <Box>
          <Flex alignItems={"baseline"} gap="2">
            <Heading size="md">Complete Self Review</Heading>
            <Text fontSize="sm" color="fg.muted">
              Due {formatInTimeZone(evalDeadline, time_zone || "America/New_York", "MMM d h:mm aaa")} ({time_zone})
            </Text>
          </Flex>
          <Text fontSize="sm" color="fg.muted">
            To complete your self review assignment, press the button below and answer a few short questions about your
            implementation.
          </Text>

          {!reviewSubmissions || reviewSubmissions?.data.length == 0 ? (
            <Button
              onClick={() => {
                router.push(
                  `/course/${course_id}/assignments/${assignment_id}/submissions/${selfReviewAssignment?.submission_id}/files?review_assignment_id=${selfReviewAssignment?.id}`
                );
              }}
            >
              Complete Now
            </Button>
          ) : (
            <Flex>You have already submitted your review for this assignment.</Flex>
          )}
        </Box>
      ) : review_settings?.enabled ? (
        <>
          <Flex alignItems="center" gap="2">
            <FaExclamationTriangle />
            <Heading size="md">Self Review Notice</Heading>
          </Flex>
          <Text fontSize="sm" color="fg.muted">
            There is a self review scheduled on this assignment which will release immediately after your deadline
            passes and will be <strong>due {review_settings?.deadline_offset} hours later.</strong>
          </Text>
        </>
      ) : (
        <></>
      )}
    </>
  );
}

// Main component that provides the AssignmentProvider context
export default function SelfReviewNotice(props: {
  review_settings: SelfReviewSettings;
  assignment: Assignment;
  enrollment: UserRole;
  activeSubmission: Submission | undefined;
}) {
  return (
    <AssignmentProvider>
      <SelfReviewNoticeInner {...props} />
    </AssignmentProvider>
  );
}
