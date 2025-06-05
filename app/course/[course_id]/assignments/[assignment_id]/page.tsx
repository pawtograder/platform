import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { AssignmentDueDate } from "@/components/ui/assignment-due-date";
import Markdown from "@/components/ui/markdown";
import { Repository, SelfReviewSettings, UserRole } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/server";
import { Alert, Box, Flex, Heading, HStack, Link, Table, Text, VStack } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { CommitHistoryDialog } from "./commitHistory";
import FinishSubmissionEarly from "./finalizeSubmissionEarly";
import ManageGroupWidget from "./manageGroupWidget";
import SelfReviewNotice from "@/components/ui/self-review-notice";

function RepositoriesInfo({ repositories }: { repositories: Repository[] }) {
  if (repositories?.length === 0) {
    return (
      <Text fontSize="sm" color="text.muted">
        No repositories found. Please refresh the page. If this issue persists, please contact your instructor.
      </Text>
    );
  }
  if (repositories?.length === 1) {
    return (
      <HStack>
        <Text fontSize="sm" fontWeight="bold">
          Repository:{" "}
        </Text>
        <Link href={`https://github.com/${repositories[0]?.repository}`}>{repositories[0]?.repository}</Link>
      </HStack>
    );
  }
  const groupRepo = repositories.find((r) => r.assignment_group_id !== null);
  const personalRepo = repositories.find((r) => r.assignment_group_id === null);
  return (
    <VStack textAlign="left" alignItems="flex-start" fontSize="sm" color="text.muted">
      <HStack>
        <Text fontWeight="bold" fontSize="sm">
          Current group repository:
        </Text>{" "}
        <Link href={`https://github.com/${groupRepo?.repository}`}>{groupRepo?.repository}</Link>
      </HStack>
      <Text fontWeight="bold">
        Note that you have multiple repositories currently. Please be sure that you are developing in the correct one
        (the current group repository).
      </Text>
      <Text>
        Individual repository (not in use, you are now in a group):{" "}
        <Link href={`https://github.com/${personalRepo?.repository}`}>{personalRepo?.repository}</Link>
      </Text>
    </VStack>
  );
}
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
    .select("*, classes(time_zone)")
    .eq("class_id", Number.parseInt(course_id))
    .eq("user_id", user.id)
    .single();
  const timeZone = enrollment?.classes?.time_zone || "America/New_York";
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
  if (assignment.group_config !== "individual" && enrollment?.private_profile_id) {
    const { data: group } = await client
      .from("assignment_groups_members")
      .select("*, assignment_groups!id(*)")
      .eq("assignment_id", Number.parseInt(assignment_id))
      .eq("profile_id", enrollment.private_profile_id)
      .single();
    assignment_group_id = group?.assignment_group_id;
  }
  const { data: repositories } = await client
    .from("repositories")
    .select("*")
    .eq("assignment_id", Number.parseInt(assignment_id))
    .or(
      assignment_group_id
        ? `assignment_group_id.eq.${assignment_group_id},profile_id.eq.${enrollment?.private_profile_id}`
        : `profile_id.eq.${enrollment?.private_profile_id}`
    );

  const { data: review_settings } = await client
    .from("assignment_self_review_settings")
    .select("*")
    .eq("id", assignment.self_review_setting_id)
    .single();

  return (
    <Box p={4}>
      <Flex width="100%" alignItems={"center"}>
        <Box width="50%">
          <Heading size="lg">{assignment.title}</Heading>
          <HStack>
            <Text>Due: </Text>
            <AssignmentDueDate assignment={assignment} showLateTokenButton={true} showTimeZone={true} />
          </HStack>
        </Box>
        {review_settings && review_settings.allow_early && (
          <FinishSubmissionEarly assignment={assignment} private_profile_id={enrollment?.private_profile_id} />
        )}
      </Flex>

      <Markdown>{assignment.description}</Markdown>
      {!assignment.template_repo || !assignment.template_repo.includes("/") ? (
        <Alert.Root status="error" flexDirection="column">
          <Alert.Title>No repositories configured for this assignment</Alert.Title>
          <Alert.Description>
            Your instructor has not set up a template repository for this assignment, so you will not be able to create
            a repository for this assignment. If you believe this is an error, please contact your instructor.
          </Alert.Description>
        </Alert.Root>
      ) : (
        <Box m={4} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle">
          <RepositoriesInfo repositories={repositories ?? []} />
        </Box>
      )}
      <Box m={4} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle">
        <ManageGroupWidget assignment={assignment} />
      </Box>
      <Box m={4} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle">
        <SelfReviewNotice
          review_settings={review_settings ?? ({} as SelfReviewSettings)}
          assignment={assignment}
          enrollment={enrollment ?? ({} as UserRole)}
          activeSubmission={submissions?.find((sm) => {
            return sm.is_active;
          })}
        />
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
                  {!assignment_group_id || submission.assignment_group_id
                    ? submission.ordinal
                    : `(Old #${submission.ordinal})`}
                </Link>
              </Table.Cell>
              <Table.Cell>
                <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                  {format(new TZDate(submission.created_at, timeZone), "MMM d h:mm aaa")}
                </Link>
              </Table.Cell>
              <Table.Cell>
                <Link href={`https://github.com/${submission.repository}/commit/${submission.sha}`}>
                  {submission.sha.slice(0, 7)}
                </Link>
              </Table.Cell>
              <Table.Cell>
                <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                  {submission.grader_results?.errors || submission.grader_results?.score === undefined
                    ? "Error"
                    : `${submission.grader_results?.score}/${submission.grader_results?.max_score}`}
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
