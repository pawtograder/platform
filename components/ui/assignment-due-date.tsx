"use client";

import { Assignment, AssignmentDueDateException, AssignmentGroup } from "@/utils/supabase/DatabaseTypes";
import { useAssignmentDueDate, useCourse, useLateTokens } from "@/hooks/useCourseController";
import { addHours, format } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { Skeleton } from "./skeleton";
import { Button } from "./button";
import { Text, HStack, Dialog, Heading } from "@chakra-ui/react";
import { Alert } from "./alert";
import { useCreate, useList, useOne } from "@refinedev/core";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useState } from "react";
import { toaster, Toaster } from "./toaster";

function LateTokenButton({ assignment }: { assignment: Assignment }) {
  const dueDate = useAssignmentDueDate(assignment);
  const lateTokens = useLateTokens();
  const [open, setOpen] = useState(false);
  const { private_profile_id, role } = useClassProfiles();
  const course = role.classes;
  const { data: assignmentGroup } = useList<AssignmentGroup>({
    resource: "assignment_groups",
    filters: [
      {
        field: "assignment_id",
        operator: "eq",
        value: assignment.id
      }
    ]
  });
  const assignment_group_id = assignmentGroup?.data?.[0]?.id;
  const { mutateAsync: createAssignmentDueDateException } = useCreate<AssignmentDueDateException>({
    resource: "assignment_due_date_exceptions"
  });
  if (!lateTokens || !dueDate) {
    return <Skeleton height="20px" width="80px" />;
  }
  const lateTokensUsedByStudent = lateTokens.filter((e) => e.tokens_consumed > 0).length;
  const lateTokensAppliedToAssignment = lateTokens
    .filter((e) => e.assignment_id === assignment.id)
    .map((e) => e.tokens_consumed)
    .reduce((a, b) => a + b, 0);
  if (course.late_tokens_per_student === 0) {
    return <Text>(No late submissions allowed)</Text>;
  }
  if (lateTokensUsedByStudent >= course.late_tokens_per_student) {
    return <Text>(You have no remaining late tokens)</Text>;
  }
  if (lateTokensAppliedToAssignment >= assignment.max_late_tokens) {
    return <Text>(You may not extend the due date for this assignment any further)</Text>;
  }
  //Make sure that our own due date is still in the future
  const extensionsInHours = lateTokens
    .filter((e) => e.assignment_id === assignment.id)
    .map((e) => e.hours)
    .reduce((a, b) => a + b, 0);
  const timezone = course.time_zone || "America/New_York";
  const ourDueDate = addHours(new TZDate(assignment.due_date, timezone), extensionsInHours);
  if (ourDueDate < new TZDate(new Date(), timezone)) {
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
            <Dialog.Title>Extend Due Date For {assignment.title}</Dialog.Title>
            <Dialog.Description>
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
            <Text>
              You can extend the due date for this assignment by up to{" "}
              {assignment.max_late_tokens - lateTokensAppliedToAssignment} more tokens. Each token extends the due date
              by 24 hours.
            </Text>
            <Alert status="warning" mt={2}>
              <Text>
                Once you consume a late token, it is consumed immediately. You will not be able to undo this action.
              </Text>
            </Alert>
            <Button
              variant="solid"
              colorPalette="red"
              w="100%"
              mt={4}
              onClick={async () => {
                try {
                  await createAssignmentDueDateException({
                    values: {
                      assignment_id: assignment.id,
                      assignment_group_id,
                      class_id: course.id,
                      student_id: assignment_group_id ? null : private_profile_id,
                      hours: 24,
                      tokens_consumed: 1,
                      creator_id: private_profile_id
                    }
                  });
                  setOpen(false);
                  toaster.create({
                    title: "Late token consumed",
                    description: "The late token has been consumed and the due date has been extended by 24 hours.",
                    type: "success"
                  });
                } catch (err) {
                  toaster.create({
                    title: "Error consuming late token",
                    description:
                      "An error occurred while consuming the late token. Please try again, and reach out to your instructor if the problem persists.",
                    type: "error"
                  });
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
  showLateTokenButton = false
}: {
  assignment: Assignment;
  showLateTokenButton?: boolean;
}) {
  const { dueDate, originalDueDate, hoursExtended, lateTokensConsumed } = useAssignmentDueDate(assignment);
  if (!dueDate || !originalDueDate) {
    return <Skeleton height="20px" width="80px" />;
  }
  return (
    <HStack>
      <Text>{format(dueDate, "MMM d h:mm aaa")}</Text>
      {hoursExtended > 0 && (
        <Text>
          ({hoursExtended}-hour extension applied, {lateTokensConsumed} late tokens consumed)
        </Text>
      )}
      {showLateTokenButton && <LateTokenButton assignment={assignment} />}
    </HStack>
  );
}
