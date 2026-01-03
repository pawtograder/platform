"use client";

import { AssignmentsForStudentDashboard } from "@/app/course/[course_id]/assignments/page";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  useAssignmentDueDate,
  useAssignmentGroupForUser,
  useCourseController,
  useLateTokens
} from "@/hooks/useCourseController";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Dialog, Flex, Heading, HStack, Text } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { addHours, isAfter } from "date-fns";
import { useState } from "react";
import { Alert } from "./alert";
import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { toaster, Toaster } from "./toaster";

function LateTokenButton({ assignment }: { assignment: Assignment }) {
  const { private_profile_id, role } = useClassProfiles();
  const lateTokens = useLateTokens();
  const [open, setOpen] = useState(false);
  const course = role.classes;
  const [isLoading, setIsLoading] = useState(false);
  const { assignmentDueDateExceptions } = useCourseController();
  const assignment_group_id = useAssignmentGroupForUser({ assignment_id: assignment.id })?.id;
  const dueDate = useAssignmentDueDate(assignment, {
    studentPrivateProfileId: private_profile_id,
    assignmentGroupId: assignment_group_id
  });
  const hoursExtended = dueDate.hoursExtended;

  if (!lateTokens || !dueDate) {
    return <Skeleton height="20px" width="80px" />;
  }
  const lateTokensUsedByStudent = lateTokens.reduce((a, b) => a + (b.tokens_consumed > 0 ? b.tokens_consumed : 0), 0);
  const lateTokensAppliedToAssignment = lateTokens
    .filter((e) => e.assignment_id === assignment.id)
    .map((e) => e.tokens_consumed)
    .reduce((a, b) => a + b, 0);
  if (course.late_tokens_per_student === 0) {
    return <Text>(No late submissions allowed)</Text>;
  }
  if (hoursExtended && hoursExtended < 0) {
    return (
      <Text fontSize="sm" color="fg.muted">
        (You may not extend the due date for this assignment as you finalized early)
      </Text>
    );
  }
  if (lateTokensUsedByStudent >= course.late_tokens_per_student) {
    return (
      <Text fontSize="sm" color="fg.muted">
        (You have no remaining late tokens)
      </Text>
    );
  }
  if (lateTokensAppliedToAssignment >= assignment.max_late_tokens) {
    return (
      <Text fontSize="sm" color="fg.muted">
        (You may not extend the due date for this assignment any further)
      </Text>
    );
  }

  // Use the calculated due date from the hook (which considers lab-based scheduling and extensions)
  if (!dueDate.dueDate) {
    return <Skeleton height="20px" width="80px" />;
  }

  if (isAfter(new TZDate(new Date()), dueDate.dueDate)) {
    return <Text>(Firm date: You have passed the due date)</Text>;
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);
      }}
    >
      <Toaster />
      <Dialog.Trigger asChild>
        <Button size="xs" variant="surface" colorPalette="yellow">
          Extend Due Date
        </Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Description>
              <Dialog.Title>Extend Due Date For {assignment.title}</Dialog.Title>
              The course late policy grants each student {course.late_tokens_per_student} late tokens. Each token
              extends the due date by 24 hours, but are not automatically applied - to use them, you must use this form
              to apply them BEFORE the assignment is due. You can apply up to {assignment.max_late_tokens} tokens to
              this assignment. You have already applied {lateTokensAppliedToAssignment} tokens to this assignment.
              {assignment.max_late_tokens > 1 && (
                <>
                  Note that to apply multiple tokens, you must use this form multiple times, always being sure to extend
                  the due date before the previous due date passes.
                </>
              )}
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <Heading size="sm">Late Tokens</Heading>
            <Text>You have {course.late_tokens_per_student - lateTokensUsedByStudent} late tokens remaining.</Text>
            <Text>You have {lateTokensAppliedToAssignment} late tokens applied to this assignment.</Text>
            {assignment_group_id && (
              <Text>
                This is a group assignment. You will extend the due date for your whole group, and it is OK if not all
                group members have enough tokens. However, all group members will have a token deducted.
              </Text>
            )}
            <Text>
              You can extend the due date for this assignment by up to{" "}
              {assignment.max_late_tokens - lateTokensAppliedToAssignment} more tokens. Each token extends the due date
              by 24 hours.
            </Text>
            <Alert status="warning" mt={2}>
              <Text>
                Once you consume a late token, it is consumed immediately. You will not be able to undo this action.
              </Text>
              {assignment_group_id && <Text fontWeight="bold">All group members will have a token deducted.</Text>}
            </Alert>
            <Button
              variant="solid"
              colorPalette="red"
              w="100%"
              loading={isLoading}
              mt={4}
              onClick={async () => {
                try {
                  setIsLoading(true);
                  await assignmentDueDateExceptions.create({
                    assignment_id: assignment.id,
                    assignment_group_id,
                    class_id: course.id,
                    student_id: assignment_group_id ? null : private_profile_id,
                    hours: 24,
                    tokens_consumed: 1,
                    creator_id: private_profile_id
                  });

                  setOpen(false);
                  toaster.create({
                    title: "Late token consumed",
                    description: "The late token has been consumed and the due date has been extended by 24 hours.",
                    type: "success"
                  });
                } catch (err) {
                  console.error(err);
                  toaster.create({
                    title: "Error consuming late token",
                    description:
                      "An error occurred while consuming the late token. Please try again, and reach out to your instructor if the problem persists.",
                    type: "error"
                  });
                } finally {
                  setIsLoading(false);
                }
              }}
            >
              Consume a late token for a 24 hour extension
            </Button>
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
export function AssignmentDueDate({
  assignment,
  showLateTokenButton = false,
  showTimeZone = false,
  showDue = false
}: {
  assignment: Assignment;
  showLateTokenButton?: boolean;
  showTimeZone?: boolean;
  showDue?: boolean;
}) {
  const { private_profile_id } = useClassProfiles();
  const ourAssignmentGroup = useAssignmentGroupForUser({ assignment_id: assignment.id });
  const { dueDate, originalDueDate, hoursExtended, lateTokensConsumed, time_zone } = useAssignmentDueDate(assignment, {
    studentPrivateProfileId: private_profile_id,
    assignmentGroupId: ourAssignmentGroup?.id
  });
  if (!dueDate || !originalDueDate) {
    return <Skeleton height="20px" width="80px" />;
  }
  return (
    <Flex gap={1} wrap="wrap" maxWidth="100%">
      <Flex alignItems={"center"} gap={1} wrap="wrap" minWidth={0}>
        {showDue && <Text flexShrink={0}>Due: </Text>}
        <Text minWidth={0} data-visual-test="blackout">
          <TimeZoneAwareDate date={dueDate} format="MMM d, h:mm a" />
        </Text>
        {hoursExtended > 0 && (
          <Text>
            ({hoursExtended}-hour extension applied, {lateTokensConsumed} late tokens consumed)
          </Text>
        )}
        {showLateTokenButton && <LateTokenButton assignment={assignment} />}
      </Flex>
    </Flex>
  );
}

export function SelfReviewDueDate({
  assignment,
  showTimeZone = false
}: {
  assignment: AssignmentsForStudentDashboard;
  showTimeZone?: boolean;
}) {
  const { private_profile_id } = useClassProfiles();
  const ourAssignmentGroup = useAssignmentGroupForUser({ assignment_id: assignment.id });
  const { dueDate, originalDueDate, time_zone } = useAssignmentDueDate(
    { id: assignment.id, due_date: assignment.due_date!, minutes_due_after_lab: assignment.minutes_due_after_lab },
    {
      studentPrivateProfileId: private_profile_id,
      assignmentGroupId: ourAssignmentGroup?.id
    }
  );
  if (!dueDate || !originalDueDate) {
    return <Skeleton height="20px" width="80px" />;
  }
  return (
    <HStack gap={1}>
      <Text>
        <TimeZoneAwareDate
          date={addHours(dueDate, assignment.self_review_deadline_offset ?? 0)}
          format="MMM d, h:mm a"
        />
      </Text>
    </HStack>
  );
}
