"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import {
  getCommitHistorySourceLabel,
  getSubmissionAutograderLabel,
  mergeCommitHistory,
  RepositoryCheckRunForHistory,
  SubmissionForCommitHistory
} from "@/lib/commitHistory";
import { repositoryListCommits, triggerWorkflow } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Repository, SubmissionWithGraderResultsAndReview } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, CloseButton, Code, Dialog, Flex, HStack, Icon, Skeleton, Table, Text } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { FaGitAlt, FaPlay } from "react-icons/fa";

type RepositoryCommitHistoryDialogProps = {
  courseId: number;
  assignmentId: number;
  repositoryId?: number;
  repositoryFullName: string;
  studentOrGroupLabel?: string;
  showTriggerAction?: boolean;
  trigger?: ReactNode;
};

function sourceBadgeColor(source: ReturnType<typeof mergeCommitHistory>[number]["source"]) {
  if (source === "github") {
    return "blue";
  }
  if (source === "database_and_github") {
    return "green";
  }
  return "purple";
}

function workflowStatusText(status: ReturnType<typeof mergeCommitHistory>[number]["status"]) {
  if (status.completed_at) {
    return status.conclusion ? `Completed: ${status.conclusion}` : "Completed";
  }
  if (status.started_at || status.check_run_marked_in_progress_at) {
    return "In progress";
  }
  if (status.workflow_triggered_at) {
    return "Workflow triggered";
  }
  if (status.requested_at) {
    return "Requested";
  }
  return "Not triggered";
}

function SubmissionLinks({
  submissions,
  courseId,
  assignmentId
}: {
  submissions: SubmissionForCommitHistory[];
  courseId: number;
  assignmentId: number;
}) {
  if (submissions.length === 0) {
    return (
      <Text fontSize="sm" color="fg.muted">
        No submissions
      </Text>
    );
  }
  return (
    <Box>
      {submissions.map((submission) => (
        <HStack key={submission.id} gap={1} fontSize="sm" flexWrap="wrap">
          <Link href={`/course/${courseId}/assignments/${assignmentId}/submissions/${submission.id}`}>
            {submission.is_active ? <ActiveSubmissionIcon /> : null}#{submission.ordinal ?? submission.id}
          </Link>
          <Text color="fg.muted">
            <TimeZoneAwareDate date={submission.created_at} format="MMM d, h:mm a" />
          </Text>
          <Text>{getSubmissionAutograderLabel(submission)}</Text>
        </HStack>
      ))}
    </Box>
  );
}

export function RepositoryCommitHistoryDialog({
  courseId,
  assignmentId,
  repositoryId,
  repositoryFullName,
  studentOrGroupLabel,
  showTriggerAction = false,
  trigger
}: RepositoryCommitHistoryDialogProps) {
  const [open, setOpen] = useState(false);
  const [githubCommits, setGithubCommits] = useState<Awaited<ReturnType<typeof repositoryListCommits>>["commits"]>([]);
  const [githubPage, setGithubPage] = useState(0);
  const [hasMoreGitHubCommits, setHasMoreGitHubCommits] = useState(false);
  const [isLoadingGitHubCommits, setIsLoadingGitHubCommits] = useState(false);
  const [githubCommitError, setGithubCommitError] = useState<string | null>(null);
  const [triggeringSha, setTriggeringSha] = useState<string | null>(null);

  const { data: resolvedRepositoryData } = useList<Repository>({
    resource: "repositories",
    filters: [
      { field: "assignment_id", operator: "eq", value: assignmentId },
      { field: "repository", operator: "eq", value: repositoryFullName }
    ],
    pagination: { pageSize: 1 },
    queryOptions: { enabled: open && repositoryId === undefined }
  });
  const effectiveRepositoryId = repositoryId ?? resolvedRepositoryData?.data?.[0]?.id;

  const checkRunsQuery = useList<RepositoryCheckRunForHistory>({
    resource: "repository_check_runs",
    filters: effectiveRepositoryId ? [{ field: "repository_id", operator: "eq", value: effectiveRepositoryId }] : [],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: open && effectiveRepositoryId !== undefined }
  });

  const submissionsQuery = useList<SubmissionWithGraderResultsAndReview>({
    resource: "submissions",
    meta: {
      select:
        "*, grader_results!grader_results_submission_id_fkey(*), submission_reviews!submissions_grading_review_id_fkey(*)"
    },
    filters: [
      { field: "assignment_id", operator: "eq", value: assignmentId },
      { field: "repository", operator: "eq", value: repositoryFullName }
    ],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: open }
  });

  const loadGitHubCommits = useCallback(
    async (page: number) => {
      setIsLoadingGitHubCommits(true);
      setGithubCommitError(null);
      try {
        const supabase = createClient();
        const response = await repositoryListCommits(
          {
            course_id: courseId,
            repo_name: repositoryFullName,
            page
          },
          supabase
        );
        setGithubCommits((current) => (page === 1 ? response.commits : [...current, ...response.commits]));
        setHasMoreGitHubCommits(response.has_more);
        setGithubPage(page);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load GitHub commit history.";
        setGithubCommitError(message);
      } finally {
        setIsLoadingGitHubCommits(false);
      }
    },
    [courseId, repositoryFullName]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setGithubCommits([]);
    setGithubPage(0);
    setHasMoreGitHubCommits(false);
    setGithubCommitError(null);
    void loadGitHubCommits(1);
  }, [open, loadGitHubCommits]);

  const entries = useMemo(
    () =>
      mergeCommitHistory({
        checkRuns: (checkRunsQuery.data?.data ?? []) as RepositoryCheckRunForHistory[],
        githubCommits,
        submissions: (submissionsQuery.data?.data ?? []) as SubmissionForCommitHistory[]
      }),
    [checkRunsQuery.data?.data, githubCommits, submissionsQuery.data?.data]
  );

  const onTriggerCommit = useCallback(
    async (sha: string) => {
      const supabase = createClient();
      setTriggeringSha(sha);
      try {
        const response = await triggerWorkflow({ repository: repositoryFullName, sha, class_id: courseId }, supabase);
        toaster.success({
          title: "Grading workflow triggered",
          description: `Created request ${response.repository_check_run_id} for ${sha.slice(0, 7)}. A new submission will appear when the workflow starts.`
        });
      } catch (error) {
        toaster.error({
          title: "Could not trigger grading",
          description: error instanceof Error ? error.message : "Unknown error"
        });
      } finally {
        // Refetch in both branches: even on error the function may have updated
        // the check_run row (e.g. requested_at) before dispatch failed.
        await checkRunsQuery.refetch();
        setTriggeringSha(null);
      }
    },
    [checkRunsQuery, courseId, repositoryFullName]
  );

  const defaultTrigger = (
    <Button size="sm" variant="outline">
      <Icon as={FaGitAlt} />
      Commit History
    </Button>
  );

  return (
    <Dialog.Root open={open} onOpenChange={(details) => setOpen(details.open)} size="cover">
      <Dialog.Trigger asChild>{trigger ?? defaultTrigger}</Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content p={3}>
          <Dialog.Header p={0}>
            <Flex justify="space-between" align="center" gap={4}>
              <Box>
                <Dialog.Title>Commit History</Dialog.Title>
                <Text fontSize="sm" color="fg.muted">
                  {studentOrGroupLabel ? `${studentOrGroupLabel} · ` : ""}
                  {repositoryFullName}
                </Text>
              </Box>
              <Dialog.CloseTrigger asChild>
                <CloseButton bg="bg" size="sm" />
              </Dialog.CloseTrigger>
            </Flex>
          </Dialog.Header>
          <Dialog.Body p={0} pt={3}>
            {githubCommitError && (
              <Box bg="bg.warning" borderColor="border.warning" borderWidth="1px" borderRadius="md" p={2} mb={2}>
                <Text fontSize="sm">
                  GitHub commits could not be loaded: {githubCommitError}. Showing commits already recorded by
                  Pawtograder.
                </Text>
              </Box>
            )}
            {(checkRunsQuery.isLoading || submissionsQuery.isLoading) && <Skeleton height="80px" />}
            <Box overflowX="auto">
              <Table.Root size="sm" minW="1100px">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Commit</Table.ColumnHeader>
                    <Table.ColumnHeader>Commit date/time</Table.ColumnHeader>
                    <Table.ColumnHeader>Author</Table.ColumnHeader>
                    <Table.ColumnHeader>Message</Table.ColumnHeader>
                    <Table.ColumnHeader>Status</Table.ColumnHeader>
                    <Table.ColumnHeader>Submissions</Table.ColumnHeader>
                    {showTriggerAction && <Table.ColumnHeader>Actions</Table.ColumnHeader>}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {entries.length === 0 && (
                    <Table.Row>
                      <Table.Cell colSpan={showTriggerAction ? 7 : 6}>
                        <Text color="fg.muted">No commits found for this repository.</Text>
                      </Table.Cell>
                    </Table.Row>
                  )}
                  {entries.map((entry) => (
                    <Table.Row key={entry.sha}>
                      <Table.Cell>
                        <Link href={entry.htmlUrl ?? `https://github.com/${repositoryFullName}/commit/${entry.sha}`}>
                          <Code fontSize="xs">{entry.sha.slice(0, 7)}</Code>
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        {entry.commitDate ? (
                          <TimeZoneAwareDate date={entry.commitDate} format="Pp" />
                        ) : (
                          <Text color="fg.muted">Unknown</Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>{entry.author ?? "Unknown"}</Table.Cell>
                      <Table.Cell maxW="360px">
                        <Text lineClamp={3}>{entry.commitMessage}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex direction="column" gap={1} align="flex-start">
                          <Badge colorPalette={sourceBadgeColor(entry.source)}>
                            {getCommitHistorySourceLabel(entry.source)}
                          </Badge>
                          <Text fontSize="xs" color="fg.muted">
                            {workflowStatusText(entry.status)}
                          </Text>
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <SubmissionLinks
                          submissions={entry.submissions}
                          courseId={courseId}
                          assignmentId={assignmentId}
                        />
                      </Table.Cell>
                      {showTriggerAction && (
                        <Table.Cell>
                          <PopConfirm
                            triggerLabel={`Trigger grading for ${entry.sha.slice(0, 7)}`}
                            confirmHeader="Trigger grading workflow"
                            confirmText="This will trigger grading for this commit, creating a new submission when the workflow starts. Instructor-triggered grading overrides deadlines and submission limits."
                            onConfirm={() => onTriggerCommit(entry.sha)}
                            trigger={
                              <Button size="xs" colorPalette="blue" loading={triggeringSha === entry.sha}>
                                <Icon as={FaPlay} />
                                Trigger grading
                              </Button>
                            }
                          />
                        </Table.Cell>
                      )}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
            <HStack justify="space-between" mt={3}>
              <Text fontSize="sm" color="fg.muted">
                {entries.length} commit{entries.length === 1 ? "" : "s"} shown
              </Text>
              {hasMoreGitHubCommits && (
                <Button
                  size="sm"
                  variant="outline"
                  loading={isLoadingGitHubCommits}
                  onClick={() => loadGitHubCommits(githubPage + 1)}
                >
                  Load more commits
                </Button>
              )}
            </HStack>
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
