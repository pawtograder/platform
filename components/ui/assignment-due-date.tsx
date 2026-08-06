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
import { Dialog, Heading, HStack, Text } from "@chakra-ui/react";
import { DueDateDisplay } from "@/components/ui/due-date-display";
import { TZDate } from "@date-fns/tz";
import { addHours, isAfter } from "date-fns";
import { useState } from "react";
import { Alert } from "./alert";
import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { useSuggestedDueDateEmphasisEnabled } from "@/hooks/useCourseFeatures";
import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import { toaster } from "./toaster";

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
  const requireTokensBeforeDueDate = (assignment as Assignment & { require_tokens_before_due_date: boolean })
    .require_tokens_before_due_date;

  // Late tokens only ever move the hard `due_date`: `calculate_final_due_date` adds
  // `assignment_due_date_exceptions` on top of it, and `suggested_due_date` is a single static
  // column with no per-student exception mechanism at all. In a course that presents the suggested
  // date as "Due", calling this control "Extend Due Date" would therefore point at the one date it
  // cannot move. Name the thing it actually extends instead.
  const showSuggested = useSuggestedDueDateEmphasisEnabled() && Boolean(assignment.suggested_due_date);
  const deadlineNoun = showSuggested ? "resubmission deadline" : "due date";
  const deadlineNounTitle = showSuggested ? "Resubmission Deadline" : "Due Date";

  if (!lateTokens || !dueDate) {
    return <Skeleton height="20px" width="80px" />;
  }
  const lateTokensUsedByStudent = lateTokens.reduce((a, b) => a + b.tokens_consumed, 0);
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
        (You may not extend the {deadlineNoun} for this assignment as you finalized early)
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
        (You may not extend the {deadlineNoun} for this assignment any further)
      </Text>
    );
  }

  // Use the calculated due date from the hook (which considers lab-based scheduling and extensions)
  if (!dueDate.dueDate) {
    return <Skeleton height="20px" width="80px" />;
  }

  if (isAfter(new TZDate(new Date()), dueDate.dueDate)) {
    if ((assignment as Assignment & { require_tokens_before_due_date: boolean }).require_tokens_before_due_date) {
      return <Text>(Firm date: You have passed the {deadlineNoun})</Text>;
    }
    return <Text>(Deadline passed: submitting will auto-apply a late token if you have one remaining)</Text>;
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);
      }}
    >
      <Dialog.Trigger asChild>
        <Button size="xs" variant="surface" colorPalette="yellow">
          Extend {deadlineNounTitle}
        </Button>
      </Dialog.Trigger>
      {requireTokensBeforeDueDate && (
        <Text fontSize="sm" color="fg.muted">
          Tokens must be applied before the {deadlineNoun}.
        </Text>
      )}
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Description>
              <Dialog.Title>
                Extend {deadlineNounTitle} For {assignment.title}
              </Dialog.Title>
              {requireTokensBeforeDueDate && (
                <>
                  You must apply token before <TimeZoneAwareDate date={dueDate.dueDate} format="MMM d, h:mm a" /> - once
                  the deadline passes you will no longer be able to apply tokens.{" "}
                </>
              )}
              The course late policy grants each student {course.late_tokens_per_student} late tokens. Each token
              extends the {deadlineNoun} by 24 hours.{" "}
              {requireTokensBeforeDueDate
                ? `Tokens are not automatically applied - to use them, you must use this form to apply them BEFORE the ${deadlineNoun} passes.`
                : `Tokens can be applied before the ${deadlineNoun} using this form, or will be automatically applied when you submit after it.`}{" "}
              You can apply up to {assignment.max_late_tokens} tokens to this assignment. You have already applied{" "}
              {lateTokensAppliedToAssignment} tokens to this assignment.
              {assignment.max_late_tokens > 1 && (
                <>
                  Note that to apply multiple tokens, you must use this form multiple times, always being sure to extend
                  the {deadlineNoun} before the previous one passes.
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
                This is a group assignment. You will extend the {deadlineNoun} for your whole group, and it is OK if not
                all group members have enough tokens. However, all group members will have a token deducted.
              </Text>
            )}
            <Text>
              You can extend the {deadlineNoun} for this assignment by up to{" "}
              {assignment.max_late_tokens - lateTokensAppliedToAssignment} more tokens. Each token extends the{" "}
              {deadlineNoun} by 24 hours.
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
                    description: `The late token has been consumed and the ${deadlineNoun} has been extended by 24 hours.`,
                    type: "success"
                  });
                } catch (err) {
                  console.error(err);
                  toaster.create({
                    title: "Error consuming late token",
                    description: `${getStudentFacingErrorMessage(err)} If this keeps happening, contact your instructor.`,
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
  showDue = false
}: {
  assignment: Assignment;
  showLateTokenButton?: boolean;
  showTimeZone?: boolean;
  showDue?: boolean;
}) {
  const { private_profile_id } = useClassProfiles();
  const ourAssignmentGroup = useAssignmentGroupForUser({ assignment_id: assignment.id });
  const showSuggestedDueDate = useSuggestedDueDateEmphasisEnabled();
  const { dueDate, originalDueDate, hoursExtended, lateTokensConsumed } = useAssignmentDueDate(assignment, {
    studentPrivateProfileId: private_profile_id,
    assignmentGroupId: ourAssignmentGroup?.id
  });
  if (!dueDate || !originalDueDate) {
    return <Skeleton height="20px" width="80px" />;
  }
  return (
    <DueDateDisplay
      suggestedDueDate={assignment.suggested_due_date}
      showSuggested={showSuggestedDueDate}
      showDueLabel={showDue}
      // `dueDateNode` renders it; `dueDate` is the value behind that node, so the component can
      // tell whether the suggested date actually precedes this student's effective deadline.
      dueDate={dueDate}
      dueDateNode={
        <Text minWidth={0} data-visual-test="transparent" data-visual-placeholder="date">
          <TimeZoneAwareDate date={dueDate} format="MMM d, h:mm a" visualPlaceholder="date" />
        </Text>
      }
      trailing={
        <>
          {hoursExtended > 0 && (
            <Text>
              ({hoursExtended}-hour extension applied, {lateTokensConsumed} late tokens consumed)
            </Text>
          )}
          {showLateTokenButton && <LateTokenButton assignment={assignment} />}
        </>
      }
    />
  );
}

export function SelfReviewDueDate({
  assignment
}: {
  assignment: AssignmentsForStudentDashboard;
  showTimeZone?: boolean;
}) {
  const { private_profile_id } = useClassProfiles();
  const ourAssignmentGroup = useAssignmentGroupForUser({ assignment_id: assignment.id });
  const { dueDate, originalDueDate } = useAssignmentDueDate(
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
