"use client";

import { CommitHistoryDialog } from "@/app/course/[course_id]/assignments/[assignment_id]/commitHistory";
import CreateStudentReposButton from "@/app/course/[course_id]/assignments/createStudentReposButton";
import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Assignment, Repository, SubmissionWithGraderResultsAndReview } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, Link, Skeleton, Table, Text } from "@chakra-ui/react";
import { useList, useOne } from "@refinedev/core";
import { format } from "date-fns";
import { useParams } from "next/navigation";
export default function TestAssignmentPage() {
  const { course_id, assignment_id } = useParams();
  const { data: assignment } = useOne<Assignment>({
    resource: "assignments",
    id: Number.parseInt(assignment_id as string)
  });
  const { private_profile_id } = useClassProfiles();
  const { data: submissions } = useList<SubmissionWithGraderResultsAndReview>({
    resource: "submissions",
    meta: {
      select: "*, grader_results(*), submission_reviews!submissions_grading_review_id_fkey(*)"
    },
    sorters: [
      {
        field: "created_at",
        order: "desc"
      }
    ],
    filters: [
      { field: "assignment_id", operator: "eq", value: Number.parseInt(assignment_id as string) },
      { field: "profile_id", operator: "eq", value: private_profile_id }
    ]
  });
  const { data: repository } = useList<Repository>({
    resource: "repositories",
    meta: {
      select: "*"
    },
    filters: [
      { field: "profile_id", operator: "eq", value: private_profile_id },
      { field: "assignment_id", operator: "eq", value: Number.parseInt(assignment_id as string) }
    ]
  });
  if (!assignment?.data || !submissions?.data) {
    return <Skeleton height="100px" />;
  }
  return (
    <Box>
      <Heading size="sm">Test Assignment</Heading>
      <Text fontSize="sm" color="fg.muted">
        You can create your own repository to test the assignment. The view below is similar to what students will see.
        However, when you view the details of your submission, you will see the autograder results and the rubric
        (students may not see the rubric or hidden autograder results).
      </Text>
      {/* {repository?.data.length ? (
        <CreateStudentReposButton syncAllPermissions />
      ): <></>} */}
      {repository?.data.length ? (
        <Box p={4} borderWidth={1} borderColor="fg.muted" borderRadius={4}>
          <Heading size="md">Repository</Heading>
          <Text fontSize="sm" color="fg.muted">
            <Link href={`https://github.com/${repository.data[0].repository}`}>{repository.data[0].repository}</Link>
          </Text>
        </Box>
      ) : (
        <CreateStudentReposButton assignmentId={Number.parseInt(assignment_id as string)} />
      )}
      <Box p={4} borderWidth={1} borderColor="fg.muted" borderRadius={4}>
        <Heading size="md">Submission History</Heading>
        <CommitHistoryDialog
          assignment={assignment.data}
          assignment_group_id={undefined}
          profile_id={private_profile_id}
        />
        <Table.Root maxW="xl">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Submission #</Table.ColumnHeader>
              <Table.ColumnHeader>Date</Table.ColumnHeader>
              <Table.ColumnHeader>Commit</Table.ColumnHeader>
              <Table.ColumnHeader>Auto Grader Score</Table.ColumnHeader>
              <Table.ColumnHeader>Total Score</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {submissions.data.map((submission) => (
              <Table.Row key={submission.id}>
                <Table.Cell>
                  <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                    {submission.is_active ? <ActiveSubmissionIcon /> : ""}
                    {submission.id}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                    {format(new Date(submission.created_at), "MMM d h:mm aaa")}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <Link href={`https://github.com/${submission.repository}/commit/${submission.sha}`}>
                    {submission.sha.slice(0, 7)}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                    {!submission.grader_results
                      ? "In Progress"
                      : submission.grader_results && submission.grader_results.errors
                        ? "Error"
                        : `${submission.grader_results?.score}/${submission.grader_results?.max_score}`}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                    {submission.submission_reviews?.completed_at
                      ? `${submission.submission_reviews?.total_score}/${assignment.data.total_points}`
                      : submission.is_active
                        ? "Pending"
                        : ""}
                  </Link>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>
    </Box>
  );
}
