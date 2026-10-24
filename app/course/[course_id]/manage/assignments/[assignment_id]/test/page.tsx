"use client";

import { CommitHistoryDialog } from "@/app/course/[course_id]/assignments/[assignment_id]/commitHistory";
import CreateStudentReposButton from "@/app/course/[course_id]/assignments/createStudentReposButton";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { getDisplayedGradingTotalForStudent } from "@/lib/getDisplayedGradingTotalForStudent";
import { Assignment, Repository, SubmissionWithGraderResultsAndReview } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Heading, Link, Skeleton, Table, Text } from "@chakra-ui/react";
import { useList, useOne } from "@refinedev/core";
import { useParams } from "next/navigation";
import { FaEye } from "react-icons/fa";

export default function TestAssignmentPage() {
  const { course_id, assignment_id } = useParams();
  const { data: assignment } = useOne<Assignment>({
    resource: "assignments",
    id: Number.parseInt(assignment_id as string)
  });
  const { private_profile_id, enterSelfPreview } = useClassProfiles();
  const { data: submissions } = useList<SubmissionWithGraderResultsAndReview>({
    resource: "submissions",
    meta: {
      select:
        "*, grader_results!grader_results_submission_id_fkey(*), submission_reviews!submissions_grading_review_id_fkey(*)"
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
  // Opening a submission goes to the staff view: the two questions staff have here are "what does
  // the grading interface look like on a real submission?" and "what will the student see?", and
  // routing the first through the second made the grading view reachable only by entering the
  // student preview and then exiting it.
  const previewAsStudent = (href: string) => {
    // Client state plus a soft navigation: this provider spans both pages, so the preview simply
    // carries across. It is recorded against this assignment so it cannot follow the viewer to a
    // different one (see isSelfViewAsScope).
    enterSelfPreview(Number.parseInt(assignment_id as string), href);
  };
  return (
    <Box>
      <Heading size="sm">Test Assignment</Heading>
      <Text fontSize="sm" color="fg.muted">
        Create your own repository to test the assignment. Opening a submission shows it the way you grade it.{" "}
        <em>Preview as student</em> shows the same submission as a student sees it — read only, with their
        grade-release, rubric-visibility, and hidden-output rules — and covers this assignment only.
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
        <CreateStudentReposButton
          classId={Number.parseInt(course_id as string)}
          assignmentId={Number.parseInt(assignment_id as string)}
          forTestAssignment
        />
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
              <Table.ColumnHeader>Student view</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {submissions.data.map((submission) => (
              <Table.Row key={submission.id}>
                {(() => {
                  const submissionHref = `/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`;
                  return (
                    <>
                      <Table.Cell>
                        <Link href={submissionHref}>
                          {submission.is_active ? <ActiveSubmissionIcon /> : ""}
                          {submission.id}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <Link href={submissionHref}>
                          <TimeZoneAwareDate date={submission.created_at} format="MMM d, h:mm a" />
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        {submission.sha && submission.repository ? (
                          <Link href={`https://github.com/${submission.repository}/commit/${submission.sha}`}>
                            {submission.sha.slice(0, 7)}
                          </Link>
                        ) : submission.submitted_via === "manual" ? (
                          <span>Manual</span>
                        ) : (
                          <span>Upload</span>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Link href={submissionHref}>
                          {!submission.grader_results
                            ? "In Progress"
                            : submission.grader_results && submission.grader_results.errors
                              ? "Error"
                              : `${submission.grader_results?.score}/${submission.grader_results?.max_score}`}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <Link href={submissionHref}>
                          {submission.submission_reviews?.completed_at
                            ? `${getDisplayedGradingTotalForStudent(submission.submission_reviews, private_profile_id) ?? submission.submission_reviews.total_score ?? "—"}/${assignment.data.total_points}`
                            : submission.is_active
                              ? "Pending"
                              : ""}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        {/* The accessible name starts with the visible label so the two cannot
                            disagree (WCAG 2.5.3), and carries the submission id because every row
                            offers the same action. */}
                        <Button
                          size="xs"
                          variant="outline"
                          aria-label={`Preview as student, submission ${submission.id}`}
                          onClick={() => previewAsStudent(submissionHref)}
                        >
                          <FaEye aria-hidden />
                          Preview as student
                        </Button>
                      </Table.Cell>
                    </>
                  );
                })()}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>
    </Box>
  );
}
