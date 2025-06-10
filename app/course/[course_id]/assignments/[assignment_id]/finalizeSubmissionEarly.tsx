"use client";
import { PopConfirm } from "@/components/ui/popconfirm";
import {
  Assignment,
  AssignmentDueDateException,
  AssignmentGroupMember,
  Submission
} from "@/utils/supabase/DatabaseTypes";
import { Box, Button } from "@chakra-ui/react";
import { CrudFilter, useCreate, useList } from "@refinedev/core";
import { addHours, addMinutes, differenceInMinutes } from "date-fns";
import { useParams } from "next/navigation";

export default function FinalizeSubmissionEarly({
  assignment,
  private_profile_id
}: {
  assignment: Assignment;
  private_profile_id: string;
}) {
  const { course_id } = useParams();
  const { mutate: create } = useCreate();
  const { data: groupMember } = useList<AssignmentGroupMember>({
    resource: "assignment_groups_members",
    meta: {
      select: "*"
    },
    filters: [
      { field: "profile_id", operator: "eq", value: private_profile_id },
      { field: "assignment_id", operator: "eq", value: assignment.id }
    ],
    pagination: { pageSize: 1 }
  });

  const group_id =
    groupMember?.data && groupMember?.data.length > 0 ? groupMember.data[0]?.assignment_group_id : undefined;

  const groupOrProfileFilterStudent: CrudFilter = group_id
    ? {
        field: "assignment_group_id",
        operator: "eq",
        value: group_id
      }
    : {
        field: "student_id",
        operator: "eq",
        value: private_profile_id
      };
  const groupOrProfileFilter: CrudFilter = group_id
    ? {
        field: "assignment_group_id",
        operator: "eq",
        value: group_id
      }
    : {
        field: "profile_id",
        operator: "eq",
        value: private_profile_id
      };

  // records of student's group already moving their due date forward.  you shouldn't move your due
  // date forward multiple times
  const { data: extensionRecordsForStudent } = useList<AssignmentDueDateException>({
    resource: "assignment_due_date_exceptions",
    meta: {
      select: "*"
    },
    filters: [{ field: "assignment_id", operator: "eq", value: assignment.id }, groupOrProfileFilterStudent]
  });

  const { data: activeSubmission } = useList<Submission>({
    resource: "submissions",
    meta: {
      select: "*"
    },
    filters: [
      { field: "assignment_id", operator: "eq", value: assignment.id },
      groupOrProfileFilter,
      { field: "is_active", operator: "eq", value: true }
    ]
  });

  // makes the due date for the student and all group members NOW rather than previous.  rounds back.
  // ex if something is due at 9:15pm and the student marks "finished" at 6:30pm, their deadline will be moved
  // back 3 hours to 6:15pm so they can access the self review immediately.
  const finalizeSubmission = () => {
    if (group_id) {
      create({
        resource: "assignment_due_date_exceptions",
        values: {
          class_id: course_id,
          assignment_id: assignment.id,
          assignment_group_id: group_id,
          creator_id: private_profile_id,
          hours: -1 * Math.floor(differenceInMinutes(new Date(assignment.due_date), new Date()) / 60),
          minutes: (-1 * differenceInMinutes(new Date(assignment.due_date), new Date())) % 60,
          tokens_consumed: 0
        }
      });
    } else {
      create({
        resource: "assignment_due_date_exceptions",
        values: {
          class_id: course_id,
          assignment_id: assignment.id,
          student_id: private_profile_id,
          creator_id: private_profile_id,
          hours: -1 * Math.floor(differenceInMinutes(new Date(assignment.due_date), new Date()) / 60),
          minutes: (-1 * differenceInMinutes(new Date(assignment.due_date), new Date())) % 60,
          tokens_consumed: 0
        }
      });
    }
  };

  function deadlinePassed(): boolean {
    if (extensionRecordsForStudent === undefined) {
      return differenceInMinutes(Date.now(), new Date(assignment.due_date)) > 0;
    } else {
      const extension = extensionRecordsForStudent.data.reduce(
        (prev, cur) => {
          return { hours: cur.hours + prev.hours, minutes: cur.minutes + prev.minutes };
        },
        { hours: 0, minutes: 0 }
      );
      const modifiedDueDate = addMinutes(addHours(new Date(assignment.due_date), extension.hours), extension.minutes);
      return differenceInMinutes(Date.now(), modifiedDueDate) > 0;
    }
  }

  return (
    <Box width="50%" alignItems={"center"}>
      <PopConfirm
        triggerLabel="Finalize Submission Early"
        trigger={
          <Button
            float="right"
            variant="surface"
            colorPalette="green"
            disabled={
              (extensionRecordsForStudent?.data &&
                extensionRecordsForStudent.data.filter((record) => {
                  return record.hours < 0 || record.minutes < 0;
                }).length > 0) ||
              deadlinePassed() ||
              (activeSubmission && activeSubmission.data.length === 0)
            }
          >
            Finalize Submission Early
          </Button>
        }
        confirmHeader="Finalize Submission Early"
        confirmText="Are you sure you want to finalize your submission early? You will not be able to change your submission after this."
        onConfirm={finalizeSubmission}
        onCancel={() => {}}
      />
    </Box>
  );
}
