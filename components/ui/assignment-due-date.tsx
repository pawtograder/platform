"use client";

import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useAssignmentDueDate, useLateTokens } from "@/hooks/useCourseController";
import { Assignment, AssignmentDueDateException, AssignmentGroup } from "@/utils/supabase/DatabaseTypes";
import { Dialog, Flex, Heading, HStack, Text } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { CrudFilter, useCreate, useList } from "@refinedev/core";
import { addHours, isAfter } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useState } from "react";
import { Alert } from "./alert";
import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { toaster, Toaster } from "./toaster";

function LateTokenButton({ assignment }: { assignment: Assignment }) {
  const dueDate = useAssignmentDueDate(assignment);
  const lateTokens = useLateTokens();
  const [open, setOpen] = useState(false);
  const { private_profile_id, role } = useClassProfiles();
  const course = role.classes;
  const { data: assignmentGroup } = useList<AssignmentGroup>({
    resource: "assignment_groups",
    filters: [{ field: "assignment_id", operator: "eq", value: assignment.id }]
  });
  const assignment_group_id = assignmentGroup?.data?.[0]?.id;
  const { mutateAsync: createAssignmentDueDateException } = useCreate<AssignmentDueDateException>({
    resource: "assignment_due_date_exceptions"
  });
  const groupOrProfileFilter: CrudFilter = assignment_group_id
    ? {
        field: "assignment_group_id",
        operator: "eq",
        value: assignment_group_id
      }
    : {
        field: "student_id",
        operator: "eq",
        value: private_profile_id
      };

  const { data: exceptionsForProfile } = useList<AssignmentDueDateException>({
    resource: "assignment_due_date_exceptions",
    filters: [
      {
        field: "assignment_id",
        operator: "eq",
        value: assignment.id
      },
      groupOrProfileFilter
    ]
  });

  if (!lateTokens || !dueDate || !exceptionsForProfile) {
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
  if (
    exceptionsForProfile.data.filter((exception) => {
      return exception.hours * 60 + exception.minutes < 0;
    }).length > 0
  ) {
    return <Text>(You may not extend the due date for this assignment as you finalized early)</Text>;
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
  const ourDueDate = addHours(new TZDate(assignment.due_date), extensionsInHours);
  if (isAfter(new TZDate(new Date()), ourDueDate)) {
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
                  toaster.error({
                    title: "Error consuming late token",
                    description:
                      "An error occurred while consuming the late token. Please try again, and reach out to your instructor if the problem persists. More details: " +
                      (err instanceof Error ? err.message : "Unknown error")
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
  showLateTokenButton = false,
  showTimeZone = false,
  showDue = false
}: {
  assignment: Assignment;
  showLateTokenButton?: boolean;
  showTimeZone?: boolean;
  showDue?: boolean;
}) {
  const { dueDate, originalDueDate, hoursExtended, lateTokensConsumed, time_zone } = useAssignmentDueDate(assignment);
  if (!dueDate || !originalDueDate) {
    return <Skeleton height="20px" width="80px" />;
  }
  return (
    <Flex gap={1} wrap="wrap" maxWidth="100%">
      <Flex alignItems={"center"} gap={1} wrap="wrap" minWidth={0}>
        {showDue && <Text flexShrink={0}>Due: </Text>}
        <Text minWidth={0}>
          {formatInTimeZone(new TZDate(dueDate), time_zone || "America/New_York", "MMM d h:mm aaa")}
        </Text>
        {showTimeZone && (
          <Text fontSize="sm" flexShrink={0}>
            ({time_zone})
          </Text>
        )}
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
  assignment: Assignment;
  showTimeZone?: boolean;
}) {
  const { dueDate, originalDueDate, time_zone } = useAssignmentDueDate(assignment);
  const { data: reviewAssignment } = useList<{ deadline_offset: number }>({
    resource: "assignment_self_review_settings",
    meta: {
      select: "deadline_offset"
    },
    filters: [
      {
        field: "id",
        operator: "eq",
        value: assignment.self_review_setting_id
      }
    ]
  });

  if (!dueDate || !originalDueDate || !reviewAssignment?.data[0]) {
    return <Skeleton height="20px" width="80px" />;
  }
  return (
    <HStack gap={1}>
      <Text>
        {formatInTimeZone(
          new TZDate(addHours(dueDate, reviewAssignment.data[0].deadline_offset)),
          time_zone || "America/New_York",
          "MMM d h:mm aaa"
        )}
      </Text>
      {showTimeZone && <Text fontSize="sm">({time_zone})</Text>}
    </HStack>
  );
}
