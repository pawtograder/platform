"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { useCourseController } from "@/hooks/useCourseController";
import {
  CommitHistoryEntry,
  getCommitHistorySourceLabel,
  getSubmissionAutograderLabel,
  mergeCommitHistory,
  RepositoryCheckRunForHistory,
  SubmissionForCommitHistory
} from "@/lib/commitHistory";
import { activateSubmission, repositoryListCommits, triggerWorkflow } from "@/lib/edgeFunctions";
import type { BroadcastMessage } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { SubmissionWithGraderResultsAndReview } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Code, Flex, HStack, Icon, Skeleton, Table, Text } from "@chakra-ui/react";
import { useInvalidate, useList } from "@refinedev/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaCheckCircle, FaPlay } from "react-icons/fa";

const PENDING_ACTIVATION_TIMEOUT_MS = 10 * 60 * 1000;

type StaffCommitHistoryProps = {
  courseId: number;
  assignmentId: number;
  repositoryId: number;
  repositoryFullName: string;
  profileId: string | null;
  assignmentGroupId: number | null;
  currentSubmissionId: number;
};

function sourceBadgeColor(source: CommitHistoryEntry["source"]) {
  if (source === "github") {
    return "blue";
  }
  if (source === "database_and_github") {
    return "green";
  }
  return "purple";
}

function workflowStatusText(status: CommitHistoryEntry["status"]) {
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

function pickActivatableSubmission(submissions: SubmissionForCommitHistory[]): SubmissionForCommitHistory | undefined {
  // Prefer the active submission if one exists for this commit; otherwise the
  // most recent gradable one (skip is_not_graded since they can't become active).
  const active = submissions.find((s) => s.is_active);
  if (active) return active;
  return submissions.find((s) => !s.is_not_graded);
}

export function StaffCommitHistory({
  courseId,
  assignmentId,
  repositoryId,
  repositoryFullName,
  profileId,
  assignmentGroupId,
  currentSubmissionId
}: StaffCommitHistoryProps) {
  const courseController = useCourseController();
  const invalidate = useInvalidate();
  const [githubCommits, setGithubCommits] = useState<Awaited<ReturnType<typeof repositoryListCommits>>["commits"]>([]);
  const [githubPage, setGithubPage] = useState(0);
  const [hasMoreGitHubCommits, setHasMoreGitHubCommits] = useState(false);
  const [isLoadingGitHubCommits, setIsLoadingGitHubCommits] = useState(false);
  const [githubCommitError, setGithubCommitError] = useState<string | null>(null);
  const [busySha, setBusySha] = useState<string | null>(null);
  // SHAs whose grading workflow we triggered and are waiting to activate when
  // the resulting submission lands. Keyed off canonical sha; we also remember
  // the timeout id so we can cancel on unmount / success.
  const [pendingActivations, setPendingActivations] = useState<Map<string, number>>(() => new Map());
  const pendingActivationsRef = useRef(pendingActivations);
  pendingActivationsRef.current = pendingActivations;

  const checkRunsQuery = useList<RepositoryCheckRunForHistory>({
    resource: "repository_check_runs",
    filters: [{ field: "repository_id", operator: "eq", value: repositoryId }],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 1000 }
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
    pagination: { pageSize: 1000 }
  });

  const loadGitHubCommits = useCallback(
    async (page: number) => {
      setIsLoadingGitHubCommits(true);
      setGithubCommitError(null);
      try {
        const supabase = createClient();
        const response = await repositoryListCommits(
          { course_id: courseId, repo_name: repositoryFullName, page },
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
    setGithubCommits([]);
    setGithubPage(0);
    setHasMoreGitHubCommits(false);
    setGithubCommitError(null);
    void loadGitHubCommits(1);
  }, [loadGitHubCommits]);

  // Clear any pending timers on unmount.
  useEffect(() => {
    return () => {
      pendingActivationsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
    };
  }, []);

  const activeRowRef = useRef<HTMLTableRowElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const hasAutoScrolledRef = useRef(false);

  const entries = useMemo(
    () =>
      mergeCommitHistory({
        checkRuns: (checkRunsQuery.data?.data ?? []) as RepositoryCheckRunForHistory[],
        githubCommits,
        submissions: (submissionsQuery.data?.data ?? []) as SubmissionForCommitHistory[]
      }),
    [checkRunsQuery.data?.data, githubCommits, submissionsQuery.data?.data]
  );

  // Auto-scroll the active row into view once entries have loaded. Run once
  // per mount — re-running on every entries change would fight the user's
  // scroll if they navigate the list.
  useEffect(() => {
    if (hasAutoScrolledRef.current) return;
    if (entries.length === 0) return;
    if (!activeRowRef.current || !scrollContainerRef.current) return;
    const container = scrollContainerRef.current;
    const row = activeRowRef.current;
    container.scrollTop = Math.max(0, row.offsetTop - container.clientHeight / 2 + row.clientHeight / 2);
    hasAutoScrolledRef.current = true;
  }, [entries]);

  const clearPending = useCallback((sha: string) => {
    setPendingActivations((current) => {
      const timeoutId = current.get(sha);
      if (timeoutId === undefined) return current;
      clearTimeout(timeoutId);
      const next = new Map(current);
      next.delete(sha);
      return next;
    });
  }, []);

  const doActivate = useCallback(
    async (submissionId: number) => {
      const supabase = createClient();
      await activateSubmission({ submission_id: submissionId }, supabase);
      invalidate({ resource: "submissions", invalidates: ["list"] });
    },
    [invalidate]
  );

  // Realtime: when a new submission for a pending-activation sha appears,
  // activate it automatically. We listen on the submissions broadcast and
  // gate by repository_id + sha match.
  useEffect(() => {
    if (!courseController?.classRealTimeController) return;
    const unsubscribe = courseController.classRealTimeController.subscribe(
      { table: "submissions" },
      (message: BroadcastMessage) => {
        if (message.operation !== "INSERT" && message.operation !== "UPDATE") return;
        const data = message.data as
          | {
              id?: number;
              repository_id?: number;
              sha?: string;
              assignment_id?: number;
              is_not_graded?: boolean | null;
            }
          | undefined;
        if (!data || !data.sha || data.repository_id !== repositoryId) return;
        if (data.assignment_id !== assignmentId) return;
        const sha = data.sha;
        if (!pendingActivationsRef.current.has(sha)) return;
        if (data.is_not_graded) {
          // A NOT-GRADED submission cannot become active; stop waiting.
          clearPending(sha);
          return;
        }
        const submissionId = data.id;
        if (typeof submissionId !== "number") return;
        clearPending(sha);
        void (async () => {
          try {
            await doActivate(submissionId);
            toaster.success({
              title: "Submission created and activated",
              description: `Activated submission for ${sha.slice(0, 7)}.`
            });
          } catch (error) {
            toaster.error({
              title: "Submission created but activation failed",
              description: error instanceof Error ? error.message : "Unknown error"
            });
          }
        })();
      }
    );
    return () => {
      unsubscribe();
    };
  }, [courseController, repositoryId, assignmentId, clearPending, doActivate]);

  const onActivateExisting = useCallback(
    async (sha: string, submissionId: number) => {
      setBusySha(sha);
      try {
        await doActivate(submissionId);
        toaster.success({ title: "Active submission changed" });
      } catch (error) {
        toaster.error({
          title: "Error activating submission",
          description: error instanceof Error ? error.message : "Unknown error"
        });
      } finally {
        setBusySha(null);
      }
    },
    [doActivate]
  );

  const onCreateAndActivate = useCallback(
    async (sha: string) => {
      const supabase = createClient();
      setBusySha(sha);
      try {
        await triggerWorkflow({ repository: repositoryFullName, sha, class_id: courseId }, supabase);
        const timeoutId = window.setTimeout(() => {
          clearPending(sha);
          toaster.error({
            title: "Submission did not appear",
            description: `Grading was triggered for ${sha.slice(0, 7)} but no submission arrived within ${PENDING_ACTIVATION_TIMEOUT_MS / 60_000} minutes. Activate manually once it appears.`
          });
        }, PENDING_ACTIVATION_TIMEOUT_MS);
        setPendingActivations((current) => {
          // Cancel any prior pending timer for the same sha to avoid leaks.
          const prior = current.get(sha);
          if (prior !== undefined) clearTimeout(prior);
          const next = new Map(current);
          next.set(sha, timeoutId);
          return next;
        });
        toaster.success({
          title: "Grading workflow triggered",
          description: `Waiting for the submission for ${sha.slice(0, 7)} to appear, then it will be activated.`
        });
      } catch (error) {
        toaster.error({
          title: "Could not trigger grading",
          description: error instanceof Error ? error.message : "Unknown error"
        });
      } finally {
        await checkRunsQuery.refetch();
        setBusySha(null);
      }
    },
    [checkRunsQuery, clearPending, courseId, repositoryFullName]
  );

  return (
    <Box>
      {githubCommitError && (
        <Box bg="bg.warning" borderColor="border.warning" borderWidth="1px" borderRadius="md" p={2} mb={2}>
          <Text fontSize="sm">
            GitHub commits could not be loaded: {githubCommitError}. Showing commits already recorded by Pawtograder.
          </Text>
        </Box>
      )}
      {(checkRunsQuery.isLoading || submissionsQuery.isLoading) && <Skeleton height="80px" />}
      <Box overflowX="auto" maxHeight="500px" overflowY="auto" ref={scrollContainerRef}>
        <Table.Root size="sm" minW="900px">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Commit</Table.ColumnHeader>
              <Table.ColumnHeader>Date</Table.ColumnHeader>
              <Table.ColumnHeader>Author</Table.ColumnHeader>
              <Table.ColumnHeader>Message</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader>Submission</Table.ColumnHeader>
              <Table.ColumnHeader>Action</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {entries.length === 0 && !checkRunsQuery.isLoading && (
              <Table.Row>
                <Table.Cell colSpan={7}>
                  <Text color="fg.muted">No commits found for this repository.</Text>
                </Table.Cell>
              </Table.Row>
            )}
            {entries.map((entry) => {
              const submission = pickActivatableSubmission(entry.submissions);
              const isCurrentSubmission = submission?.id === currentSubmissionId;
              const isPending = pendingActivations.has(entry.sha);
              const isBusy = busySha === entry.sha;
              const isFromDatabase = entry.source !== "github";
              return (
                <Table.Row
                  key={entry.sha}
                  ref={isCurrentSubmission ? activeRowRef : undefined}
                  bg={isCurrentSubmission ? "bg.emphasized" : undefined}
                  data-current={isCurrentSubmission ? "true" : undefined}
                >
                  <Table.Cell>
                    <Link href={entry.htmlUrl ?? `https://github.com/${repositoryFullName}/commit/${entry.sha}`}>
                      <Code fontSize="xs">{entry.sha.slice(0, 7)}</Code>
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    {entry.commitDate ? (
                      <Flex direction="column" gap={0} align="flex-start">
                        <TimeZoneAwareDate date={entry.commitDate} format="Pp" />
                        {isFromDatabase && entry.recordedAt && (
                          <Text fontSize="xs" color="fg.muted">
                            received <TimeZoneAwareDate date={entry.recordedAt} format="Pp" />
                          </Text>
                        )}
                      </Flex>
                    ) : (
                      <Text color="fg.muted">Unknown</Text>
                    )}
                  </Table.Cell>
                  <Table.Cell>{entry.author ?? "Unknown"}</Table.Cell>
                  <Table.Cell maxW="280px">
                    <Text lineClamp={2}>{entry.commitMessage}</Text>
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
                    {submission ? (
                      <HStack gap={1} fontSize="sm" flexWrap="wrap">
                        <Link href={`/course/${courseId}/assignments/${assignmentId}/submissions/${submission.id}`}>
                          {submission.is_active ? <ActiveSubmissionIcon /> : null}#{submission.ordinal ?? submission.id}
                        </Link>
                        <Text>{getSubmissionAutograderLabel(submission)}</Text>
                      </HStack>
                    ) : (
                      <Text fontSize="sm" color="fg.muted">
                        None
                      </Text>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {submission && submission.is_active && (
                      <Text fontSize="xs" color="fg.muted">
                        Currently active
                      </Text>
                    )}
                    {submission && !submission.is_active && !submission.is_not_graded && (
                      <Button
                        size="xs"
                        colorPalette="blue"
                        loading={isBusy}
                        onClick={() => onActivateExisting(entry.sha, submission.id)}
                      >
                        <Icon as={FaCheckCircle} />
                        Activate
                      </Button>
                    )}
                    {submission && submission.is_not_graded && (
                      <Text fontSize="xs" color="fg.muted">
                        Not for grading
                      </Text>
                    )}
                    {!submission && (
                      <PopConfirm
                        triggerLabel={`Create submission and activate ${entry.sha.slice(0, 7)}`}
                        confirmHeader="Create submission and activate"
                        confirmText="This triggers a grading workflow for this commit; the resulting submission will become active automatically. Staff-triggered grading overrides deadlines and submission limits."
                        onConfirm={() => onCreateAndActivate(entry.sha)}
                        trigger={
                          <Button size="xs" colorPalette="blue" loading={isBusy || isPending}>
                            <Icon as={FaPlay} />
                            {isPending ? "Waiting for workflow…" : "Create submission and activate"}
                          </Button>
                        }
                      />
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      </Box>
      <HStack justify="space-between" mt={3}>
        <Text fontSize="sm" color="fg.muted">
          {entries.length} commit{entries.length === 1 ? "" : "s"} shown
          {profileId ? "" : assignmentGroupId ? " (group)" : ""}
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
      <Box mt={2} p={2} borderWidth="1px" borderColor="border.muted" borderRadius="md" bg="bg.subtle">
        <Text fontSize="xs" color="fg.muted">
          <strong>About these timestamps:</strong> the &ldquo;Date&rdquo; column shows the commit&apos;s author date,
          which is set by git on the committer&apos;s machine and can be backdated by adjusting the local clock. For
          commits Pawtograder recorded via a push webhook (&ldquo;Recorded by webhook&rdquo; or &ldquo;Recorded by
          webhook + GitHub&rdquo;), the &ldquo;received&rdquo; line shows when our server first saw the commit — that
          timestamp is trustworthy. For commits sourced only from the GitHub API (&ldquo;From GitHub&rdquo;), no
          server-side receipt exists, so all you have is the author-supplied date.
        </Text>
      </Box>
    </Box>
  );
}
