"use client";
import { Button } from "@/components/ui/button";
import { Assignment, Repository, SubmissionWithGraderResultsAndReview } from "@/utils/supabase/DatabaseTypes";
import { Box, CloseButton, Dialog, Flex, Heading, Skeleton, Table, Text } from "@chakra-ui/react";

import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import Link from "@/components/ui/link";
import { useCourse } from "@/hooks/useCourseController";
import { triggerWorkflow } from "@/lib/edgeFunctions";
import { RepositoryCheckRun } from "@/supabase/functions/_shared/FunctionTypes";
import { createClient } from "@/utils/supabase/client";
import { Icon } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { CrudFilter, useList } from "@refinedev/core";
import { formatRelative } from "date-fns";
import { useParams } from "next/navigation";
import { useState } from "react";
import { FaGitAlt } from "react-icons/fa";

function TriggerWorkflowButton({ repository, sha }: { repository: string; sha: string }) {
  const { course_id } = useParams();
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isError, setIsError] = useState(false);
  if (isSuccess) {
    return "Submission triggered, check back soon";
  }
  if (isError) {
    return "Error triggering submission";
  }
  return (
    <Button
      loading={isLoading}
      variant="outline"
      size="xs"
      onClick={async () => {
        setIsLoading(true);
        try {
          const supabase = createClient();
          await triggerWorkflow({ repository, sha, class_id: Number(course_id) }, supabase);
          setIsSuccess(true);
        } catch (error) {
          console.error(error);
          setIsError(true);
        } finally {
          setIsLoading(false);
        }
      }}
    >
      Create Submission
    </Button>
  );
}

function CommitHistory({
  repository_id,
  repository_full_name
}: {
  repository_id: number;
  repository_full_name: string;
}) {
  const { time_zone } = useCourse();
  const { data } = useList<SubmissionWithGraderResultsAndReview>({
    resource: "submissions",
    meta: { select: "*, assignments(*), grader_results(*), submission_reviews!submissions_grading_review_id_fkey(*)" },
    filters: [{ field: "repository", operator: "eq", value: repository_full_name }],
    sorters: [{ field: "created_at", order: "desc" }]
  });
  const { data: commits } = useList<RepositoryCheckRun>({
    resource: "repository_check_runs",
    filters: [{ field: "repository_id", operator: "eq", value: repository_id }]
  });

  return (
    <Box w="100%" bg="bg.muted" p={2} borderRadius="md" border="1px solid" borderColor="border.emphasized">
      {(!commits || !data) && <Skeleton height="20px" />}
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Commit</Table.ColumnHeader>
            <Table.ColumnHeader>Date</Table.ColumnHeader>
            <Table.ColumnHeader>Author</Table.ColumnHeader>
            <Table.ColumnHeader>Message</Table.ColumnHeader>
            <Table.ColumnHeader>Submission</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {commits?.data.map((commit) => {
            const relatedSubmission = data?.data.find((submission) => submission.sha === commit.sha);
            const commitDate = new TZDate(
              commit.status.commit_date || new Date().toUTCString(),
              time_zone || "America/New_York"
            );
            return (
              <Table.Row key={commit.sha}>
                <Table.Cell>
                  <Link href={`https://github.com/${repository_full_name}/commit/${commit.sha}`}>
                    {commit.sha.slice(0, 7)}
                  </Link>
                </Table.Cell>
                <Table.Cell>{formatRelative(commitDate, TZDate.tz(time_zone || "America/New_York"))}</Table.Cell>
                <Table.Cell>{commit.status.commit_author}</Table.Cell>
                <Table.Cell>{commit.commit_message}</Table.Cell>
                <Table.Cell>
                  {relatedSubmission ? (
                    <Link
                      href={`/course/${relatedSubmission.class_id}/assignments/${relatedSubmission.assignments.id}/submissions/${relatedSubmission.id}`}
                    >
                      {relatedSubmission.is_active && <ActiveSubmissionIcon />}#{relatedSubmission.ordinal},{" "}
                      {relatedSubmission.grader_results?.score}/{relatedSubmission.assignments.autograder_points}
                    </Link>
                  ) : (
                    <Box>
                      <Text fontSize="sm" color="text.muted">
                        Not submitted
                      </Text>
                      <TriggerWorkflowButton repository={repository_full_name} sha={commit.sha} />
                    </Box>
                  )}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
export function CommitHistoryDialog({
  assignment,
  assignment_group_id,
  profile_id
}: {
  assignment: Assignment;
  assignment_group_id: number | undefined;
  profile_id: string | undefined;
}) {
  const filters: CrudFilter[] = [{ field: "assignment_id", operator: "eq", value: assignment.id }];
  if (assignment_group_id) {
    filters.push({ field: "assignment_group_id", operator: "eq", value: assignment_group_id });
  } else if (profile_id) {
    filters.push({ field: "profile_id", operator: "eq", value: profile_id });
  }
  const { data: repository } = useList<Repository>({ resource: "repositories", filters });
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button variant="outline">
          <Icon as={FaGitAlt} />
          Commit History
        </Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content w="4xl" p={3}>
          <Dialog.Header p={0}>
            <Flex justify="space-between" align="center">
              <Heading size="md">Commit History</Heading>
              <Dialog.CloseTrigger asChild>
                <CloseButton bg="bg" size="sm" />
              </Dialog.CloseTrigger>
            </Flex>
          </Dialog.Header>
          <Dialog.Body p={0}>
            {repository && repository.data.length > 0 && (
              <CommitHistory
                repository_id={repository.data[0].id}
                repository_full_name={repository.data[0].repository}
              />
            )}
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
