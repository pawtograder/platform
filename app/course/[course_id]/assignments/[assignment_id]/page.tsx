import Markdown from "@/components/ui/markdown";
import useAuthState from "@/hooks/useAuthState";
import { createClient } from "@/utils/supabase/server";
import { Box, Heading, HStack, Link, Table, Text } from "@chakra-ui/react";
import { format } from "date-fns";
import ManageGroupWidget from "./manageGroupWidget";
import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { AssignmentDueDate } from "@/components/ui/assignment-due-date";
import { CommitHistoryDialog } from "./commitHistory";
export default async function AssignmentPage({
  params
}: {
  params: Promise<{ course_id: string; assignment_id: string }>;
}) {
  const { course_id, assignment_id } = await params;
  const client = await createClient();
  const {
    data: { user }
  } = await client.auth.getUser();
  if (!user) {
    return <div>You are not logged in</div>;
  }
  const { data: enrollment } = await client
    .from("user_roles")
    .select("*")
    .eq("class_id", Number.parseInt(course_id))
    .eq("user_id", user.id)
    .single();
  const { data: assignment } = await client
    .from("assignments")
    .select("*")
    .eq("id", Number.parseInt(assignment_id))
    .single();
  if (!assignment) {
    return <div>Assignment not found</div>;
  }

  const { data: submissions } = await client
    .from("submissions")
    .select("*, grader_results(*), submission_reviews!submissions_grading_review_id_fkey(*)")
    .eq("assignment_id", Number.parseInt(assignment_id))
    .order("created_at", { ascending: false });

  let assignment_group_id: number | undefined;
  if (assignment.group_config !== "individual") {
    const { data: group } = await client
      .from("assignment_groups_members")
      .select("*, assignment_groups!id(*)")
      .eq("assignment_id", Number.parseInt(assignment_id))
      .eq("profile_id", enrollment?.private_profile_id!)
      .single();
    assignment_group_id = group?.assignment_group_id;
  }
  return (
    <Box p={4}>
      <Heading size="lg">{assignment.title}</Heading>
      <HStack>
        <Text>Due: </Text>
        <AssignmentDueDate assignment={assignment} showLateTokenButton={true} />
      </HStack>
      <Markdown>{assignment.description}</Markdown>
      <Box m={4} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle">
        <ManageGroupWidget assignment={assignment} />
      </Box>
      <Heading size="md">Submission History</Heading>
      <CommitHistoryDialog
        assignment={assignment}
        assignment_group_id={assignment_group_id}
        profile_id={enrollment?.private_profile_id}
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
          {submissions?.map((submission) => (
            <Table.Row key={submission.id}>
              <Table.Cell>
                <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                  {submission.is_active ? <ActiveSubmissionIcon /> : ""}
                  {submission.ordinal}
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
                  {submission.grader_results?.score}/{submission.grader_results?.max_score}
                </Link>
              </Table.Cell>
              <Table.Cell>
                <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                  {submission.submission_reviews?.completed_at
                    ? `${submission.submission_reviews?.total_score}/${assignment.total_points}`
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
  );
}
