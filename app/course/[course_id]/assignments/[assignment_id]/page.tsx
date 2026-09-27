"use client";
import LinkAccount from "@/components/github/link-account";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";
import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { AssignmentDueDate } from "@/components/ui/assignment-due-date";
import AssignmentLeaderboard from "@/components/ui/assignment-leaderboard";
import Markdown from "@/components/ui/markdown";
import { NotGradedSubmissionIcon } from "@/components/ui/not-graded-submission-icon";
import SelfReviewNotice from "@/components/ui/self-review-notice";
import { SurveyStatusBanner } from "@/components/ui/survey-status-banner";
import { useAssignmentController } from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { isOwnRepositoryForAssignment } from "@/lib/ownRepositoryForAssignment";
import { useCourseController } from "@/hooks/useCourseController";
import { getDisplayedGradingTotalForStudent } from "@/lib/getDisplayedGradingTotalForStudent";
import { useFindTableControllerValue, useListTableControllerValues } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  Repository,
  SelfReviewSettings,
  SubmissionWithGraderResultsAndReview,
  UserRole
} from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { ResponsiveTable } from "@/components/ui/responsive-table";
import { Alert, Box, Flex, Grid, GridItem, Heading, HStack, Link, Skeleton, Table } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { CrudFilter, useList } from "@refinedev/core";
import { format, secondsToHours } from "date-fns";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import UploadSubmission from "@/components/submissions/upload-submission";
import { CommitHistoryDialog } from "./commitHistory";
import ManageGroupWidget from "./manageGroupWidget";
import PrSubmissionPanel from "./prSubmissionPanel";
import { graderResultIndicatesFailure } from "@/lib/graderResultStatus";

/**
 * Autograder-score label for one row of the submission history.
 *
 * Decided per submission rather than from the assignment's current
 * `has_autograder`, because that flag is mutable while submissions are
 * historical. Keying only off the flag mislabels history in both directions:
 * turning the autograder off would hide real scores from earlier Actions-backed
 * submissions as "N/A", and turning it back on would leave earlier push-direct
 * submissions stuck at "In Progress" forever.
 *
 * Order matters: real results always win, then channels that never run the
 * autograder, and only then the assignment-level fallback.
 */
function autograderScoreLabel(
  submission: {
    grader_results?: { score?: number | null; max_score?: number | null; errors?: unknown } | null;
    submitted_via?: string | null;
    run_number?: number | null;
    workflow_run_error?: unknown;
  },
  assignmentHasNoAutograder: boolean
): string {
  const results = submission.grader_results;
  if (results) {
    return graderResultIndicatesFailure(results.errors) ? "Error" : `${results.score}/${results.max_score}`;
  }
  // A retained rejection: the push-direct path keeps an oversized submission as an inactive
  // history row and attaches a student-visible workflow_run_error explaining why nothing was
  // graded. That error row is the ONLY record of the rejection — the submission itself looks
  // ordinary — so without this the newest history entry read as a successful hand-graded
  // submission and the student had no way to learn their push was refused.
  const runErrors = submission.workflow_run_error;
  if (Array.isArray(runErrors) ? runErrors.length > 0 : !!runErrors) {
    return "Error";
  }
  // Channels that never produce grader results: an upload, a manual entry, a PR
  // submission, or a push-direct submission (run_number 0 — no Actions run backs
  // it). These are "N/A" no matter what the assignment flag currently says.
  const via = submission.submitted_via;
  if (via === "upload" || via === "manual" || via === "pr") {
    return "N/A";
  }
  if (via === "git" && (submission.run_number ?? 0) === 0) {
    return "N/A";
  }
  // An Actions-backed submission (run_number > 0) with no results yet is STILL RUNNING,
  // whatever the assignment's current flag says. The backend deliberately lets a workflow
  // dispatched before a disable finish, so this combination is legitimate — and labelling
  // it N/A hid a live run and its results link until they arrived. The flag is only
  // consulted for rows whose channel cannot be determined.
  if ((submission.run_number ?? 0) > 0) {
    return "In Progress";
  }
  return assignmentHasNoAutograder ? "N/A" : "In Progress";
}

export default function AssignmentPage() {
  const { course_id, assignment_id } = useParams();
  const { private_profile_id, isReadOnly } = useClassProfiles();
  const { role: enrollment } = useClassProfiles();
  const { assignment } = useAssignmentController();
  const { repositories: repositoriesController, assignmentGroupsWithMembers, course } = useCourseController();
  const autograderData = useRef<Database["public"]["Functions"]["get_submissions_limits"]["Returns"] | null>(null);
  type AssignmentGroup = (typeof assignmentGroupsWithMembers.rows)[number];
  const ourAssignmentGroupPredicate = useMemo(() => {
    return (group: AssignmentGroup) =>
      group.assignment_groups_members.some(
        (member) => member.profile_id === private_profile_id && member.assignment_id === Number(assignment_id)
      );
  }, [private_profile_id, assignment_id]);
  const assignmentGroup = useFindTableControllerValue(assignmentGroupsWithMembers, ourAssignmentGroupPredicate);
  // Scope to *this* viewer's repository, the same way submissionsFilters below picks the group repo
  // or the individual one — see isOwnRepositoryForAssignment for why assignment_id alone was not
  // enough.
  const repositoriesPredicate = useMemo(() => {
    return (repository: Repository) =>
      isOwnRepositoryForAssignment(repository, {
        assignmentId: Number(assignment_id),
        assignmentGroupId: assignmentGroup?.id ?? null,
        profileId: private_profile_id
      });
  }, [assignment_id, assignmentGroup, private_profile_id]);
  const repositories = useListTableControllerValues(repositoriesController, repositoriesPredicate);
  const submissionsFilters = useMemo(() => {
    const filters: CrudFilter[] = [];
    filters.push({ field: "assignment_id", operator: "eq", value: assignment_id });
    if (assignmentGroup) {
      filters.push({ field: "assignment_group_id", operator: "eq", value: assignmentGroup.id });
    } else {
      filters.push({ field: "profile_id", operator: "eq", value: private_profile_id });
    }
    return filters;
  }, [assignment_id, assignmentGroup, private_profile_id]);
  const { data: submissionsData, refetch: refetchSubmissions } = useList<SubmissionWithGraderResultsAndReview>({
    resource: "submissions",
    meta: {
      // workflow_run_error is embedded because a push-direct submission rejected as oversized
      // is deliberately RETAINED with the error attached — that error row is the only record
      // of the rejection, so without it the row reads as an ordinary hand-graded submission.
      select:
        "*, grader_results!grader_results_submission_id_fkey(*), submission_reviews!submissions_grading_review_id_fkey(*), workflow_run_error(*)",
      order: "created_at, { ascending: false }"
    },
    pagination: {
      pageSize: 1000
    },
    filters: submissionsFilters,
    sorters: [
      {
        field: "created_at",
        order: "desc"
      }
    ]
  });

  useEffect(() => {
    async function fetchSubmissionLimits() {
      const supabaseClient = createClient();
      if (!assignment_id) return;
      const { data, error } = await supabaseClient.rpc("get_submissions_limits", {
        p_assignment_id: Number(assignment_id)
      });
      if (error) {
        console.error("Failed to fetch submission limits:", error);
      }
      if (!data) return;
      autograderData.current = data;
    }
    fetchSubmissionLimits();
  }, [assignment_id]);

  const submissions = submissionsData?.data;
  const autograder = autograderData.current;

  const review_settings = assignment.assignment_self_review_settings;
  const timeZone = course?.time_zone || "America/New_York";

  const autograderRow = autograder?.[0];
  const submissionsPeriod =
    autograderRow?.max_submissions_period_secs != null ? secondsToHours(autograderRow.max_submissions_period_secs) : 0;
  const maxSubmissions = autograderRow?.max_submissions_count;
  const submissionsUsed = autograderRow?.submissions_used ?? 0;
  const submissionsRemaining = autograderRow?.submissions_remaining ?? 0;

  if (!assignment) {
    return <Skeleton height="40" width="100%" />;
  }
  // No-repo / no-submission / PR-mode assignments have no autograder by
  // convention, so an autograder score is not meaningful — show "N/A" instead
  // of progress/score. `has_autograder === false` covers repo-only assignments
  // (#895), whose push submissions never get grader_results — without it the
  // score column would sit at "In Progress" forever.
  const isPrMode = assignment.submission_mode === "pr";
  const noAutograder =
    assignment.has_autograder === false ||
    assignment.repo_mode === "none" ||
    assignment.repo_mode === "no_submission" ||
    isPrMode;
  return (
    <Box p={4}>
      <LinkAccount />
      <ResendOrgInvitation />
      <Grid
        templateColumns={assignment.show_leaderboard ? { base: "1fr", lg: "1fr 320px" } : { base: "1fr", lg: "1fr" }}
        gap={4}
      >
        <GridItem>
          <Flex width="100%" alignItems={"center"}>
            <Box>
              <Heading as="h1" size="lg">
                {assignment.title}
              </Heading>
              <HStack>
                <AssignmentDueDate
                  assignment={assignment}
                  showLateTokenButton={true}
                  showTimeZone={true}
                  showDue={true}
                />
              </HStack>
            </Box>
          </Flex>

          <Markdown>{assignment.description}</Markdown>

          {isPrMode && (
            <PrSubmissionPanel
              assignment={assignment}
              assignmentGroupId={assignmentGroup?.id}
              profileId={enrollment?.private_profile_id}
              onConfirmed={() => refetchSubmissions()}
            />
          )}

          {isPrMode ? (
            <></>
          ) : assignment.repo_mode === "none" ? (
            <UploadSubmission assignmentId={Number(assignment_id)} onUploaded={() => refetchSubmissions()} />
          ) : assignment.repo_mode === "no_submission" ? (
            <Alert.Root status="info" flexDirection="column" m={4} maxW="4xl">
              <Alert.Title>No submission required</Alert.Title>
              <Alert.Description>
                There is nothing to submit here. Your instructor will grade this assignment manually (for example, a
                presentation or oral exam). Complete the task as your instructor described — your grade will appear
                below once it is released.
              </Alert.Description>
            </Alert.Root>
          ) : !assignment.template_repo || !assignment.template_repo.includes("/") ? (
            <Alert.Root status="error" flexDirection="column">
              <Alert.Title>No repositories configured for this assignment</Alert.Title>
              <Alert.Description>
                Your instructor has not set up a template repository for this assignment, so you will not be able to
                create a repository for this assignment. If you believe this is an error, please contact your
                instructor.
              </Alert.Description>
            </Alert.Root>
          ) : (
            <></>
          )}
          <Box m={4} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle" maxW="4xl">
            <ManageGroupWidget
              assignment={assignment}
              repositories={repositories ?? []}
              showRepositories={
                !isPrMode && assignment.repo_mode !== "none" && assignment.repo_mode !== "no_submission"
              }
            />
          </Box>
          <SelfReviewNotice
            review_settings={review_settings ?? ({} as SelfReviewSettings)}
            assignment={assignment}
            enrollment={enrollment ?? ({} as UserRole)}
            activeSubmission={submissions?.find((sm) => {
              return sm.is_active;
            })}
          />
          {enrollment?.role === "student" && (
            <SurveyStatusBanner assignmentId={Number(assignment_id)} courseId={Number(course_id)} />
          )}
          {/* Submission limits throttle autograder runs, so they are meaningless
              without an autograder — and the `autograder` row is auto-created with
              a default 5-per-24h limit for EVERY assignment. Showing this banner on
              a repo-only assignment would promise that extra pushes "will be
              ignored" when in fact every push becomes a gradeable submission. */}
          {submissionsPeriod && maxSubmissions && !noAutograder ? (
            <Box w="100%" maxW="4xl" data-visual-test="removed">
              <Alert.Root
                status={submissionsRemaining === 0 ? "warning" : submissionsRemaining <= 1 ? "warning" : "info"}
                flexDirection="column"
                size="md"
              >
                <Alert.Title>Submission Limit for this assignment</Alert.Title>
                <Alert.Description>
                  This assignment has a submission limit of {maxSubmissions} submission{maxSubmissions !== 1 ? "s" : ""}{" "}
                  per {submissionsPeriod} hour{submissionsPeriod !== 1 ? "s" : ""}. Submissions that receive a score of
                  &quot;0&quot; do NOT count towards the limit.
                  <br />
                  <strong>
                    You have used {submissionsUsed} of {maxSubmissions} submission{maxSubmissions !== 1 ? "s" : ""} this
                    period ({submissionsRemaining} remaining).
                  </strong>
                  {submissionsRemaining === 0 && (
                    <>
                      <br />
                      <strong>
                        Any additional commits that you push to your repository will be ignored, but will still be
                        timestamped and be viewed by course staff.
                      </strong>
                    </>
                  )}
                </Alert.Description>
              </Alert.Root>
            </Box>
          ) : (
            <></>
          )}
          <Heading size="md">Submission History</Heading>
          <CommitHistoryDialog
            assignment={assignment}
            assignment_group_id={assignmentGroup?.id}
            profile_id={enrollment?.private_profile_id}
          />
          <ResponsiveTable wrapperProps={{ maxW: "4xl" }}>
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
                <Table.Row key={submission.id} bg={submission.is_not_graded ? "bg.warning" : ""}>
                  <Table.Cell>
                    <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                      {submission.is_active ? <ActiveSubmissionIcon /> : ""}
                      {submission.is_not_graded ? <NotGradedSubmissionIcon /> : ""}
                      {!assignmentGroup || submission.assignment_group_id
                        ? submission.ordinal
                        : `(Old #${submission.ordinal})`}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                      <span data-visual-test="transparent" data-visual-placeholder="date">
                        {format(new TZDate(submission.created_at, timeZone), "MMM d h:mm aaa")}
                      </span>
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    {submission.submitted_via === "pr" && submission.repository && submission.pr_number ? (
                      <Link href={`https://github.com/${submission.repository}/pull/${submission.pr_number}`}>
                        #{submission.pr_number}
                        {submission.sha ? ` (${submission.sha.slice(0, 7)})` : ""}
                      </Link>
                    ) : submission.sha && submission.repository ? (
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
                    <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}>
                      {autograderScoreLabel(submission, noAutograder)}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    {(() => {
                      // View-as-student: a real student's RLS hides unreleased reviews, so the
                      // embedded review comes back null and the score reads "Pending"/"—". An
                      // instructor masquerading reads the review via the staff RLS path, so mirror
                      // RLS here and withhold the unreleased grade.
                      const review =
                        isReadOnly && submission.submission_reviews && !submission.submission_reviews.released
                          ? null
                          : submission.submission_reviews;
                      const gradeLabel = review?.completed_at
                        ? `${getDisplayedGradingTotalForStudent(review, private_profile_id) ?? review.total_score ?? "—"}/${assignment.total_points}`
                        : submission.is_active
                          ? "Pending"
                          : submission.is_not_graded
                            ? "Not for grading"
                            : "—";
                      return (
                        <Link
                          href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission.id}`}
                          // Only fall back to a synthetic accessible name when the visible
                          // label is the dash placeholder — otherwise the visible text is
                          // already the link's name (and tests / screen readers expect it).
                          aria-label={gradeLabel === "—" ? `Submission #${submission.ordinal} grade` : undefined}
                        >
                          {gradeLabel}
                        </Link>
                      );
                    })()}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </ResponsiveTable>
        </GridItem>

        {assignment.show_leaderboard && (
          <GridItem>
            <Box position="sticky" top={4}>
              <AssignmentLeaderboard maxEntries={10} />
            </Box>
          </GridItem>
        )}
      </Grid>
    </Box>
  );
}
