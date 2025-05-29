"use client";
import { Assignment, AssignmentDueDateException, AssignmentGroupMember } from "@/utils/supabase/DatabaseTypes";
import { Box, Button } from "@chakra-ui/react";
import { useCreate, useList } from "@refinedev/core";
import { useParams } from "next/navigation";

export default function FinalizeSubmissionEarly({
  assignment,
  group_id,
  private_profile_id
}: {
  assignment: Assignment;
  group_id?: number;
  private_profile_id?: string;
}) {
  const { course_id } = useParams();
  const { mutate: create } = useCreate();
  // teammates of current user, whose due date should also be moved forward
  const { data: memberGroup } = useList<AssignmentGroupMember>({
    resource: "assignment_groups_members",
    meta: {
      select: "*"
    },
    filters: [{ field: "profile_id", operator: "eq", value: private_profile_id }],
    pagination: { pageSize: 1 }
  });

  // records of student's group already moving their due date forward.  you shouldn't move your due
  // date forward multiple times
  const { data: finalizedEarlyRecordsForStudent } = useList<AssignmentDueDateException>({
    resource: "assignment_due_date_exceptions",
    meta: {
      select: "*"
    },

    filters: [
      { field: "student_id", operator: "eq", value: private_profile_id },
      { field: "hours", operator: "lt", value: 0 }
    ]
  });

  // calculate the number of hours the student is finishing early
  function hoursBetween(time1: string, time2: string) {
    const date1 = new Date(time1);
    const date2 = new Date(time2);
    const diffInMilli = Math.abs(date2.getTime() - date1.getTime());
    return -1 * Math.ceil(diffInMilli / 3600000); // 3600000 ms = 1 hour
  }

  // makes the due date for the student and all group members NOW rather than previous.  rounds back.
  // ex if something is due at 9:15pm and the student marks "finished" at 6:30pm, their deadline will be moved
  // back 3 hours to 6:15pm so they can access the self review immediately.
  const finalizeSubmission = () => {
    if (memberGroup && memberGroup.data.length > 0) {
      memberGroup.data.forEach((member) => {
        create({
          resource: "assignment_due_date_exceptions",
          values: {
            class_id: course_id,
            assignment_id: assignment.id,
            assignment_group_id: group_id,
            student_id: member.profile_id,
            group_id: memberGroup.data[0].assignment_group_id,
            creator_id: private_profile_id,
            hours: hoursBetween(assignment.due_date, new Date().toDateString()), // difference between assignment due date and now, should be a negative number
            tokens_consumed: 0
          }
        });
      });
    } else {
      create({
        resource: "assignment_due_date_exceptions",
        values: {
          class_id: course_id,
          assignment_id: assignment.id,
          assignment_group_id: group_id,
          student_id: private_profile_id,
          creator_id: private_profile_id,
          hours: hoursBetween(assignment.due_date, new Date().toDateString()), // difference between assignment due date and now, should be a negative number
          tokens_consumed: 0
        }
      });
    }
  };

  return (
    <Box width="50%" alignItems={"center"}>
      <Button
        float="right"
        disabled={
          // disabled when previously finalized early
          finalizedEarlyRecordsForStudent &&
          finalizedEarlyRecordsForStudent.data &&
          finalizedEarlyRecordsForStudent.data.length > 0
        }
        onClick={finalizeSubmission}
      >
        Finalize Submission Early
      </Button>
    </Box>
  );
}
