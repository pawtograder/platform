"use client";
import LinkAccount from "@/components/github/link-account";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";
import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { AssignmentDueDate } from "@/components/ui/assignment-due-date";
import Markdown from "@/components/ui/markdown";
import { NotGradedSubmissionIcon } from "@/components/ui/not-graded-submission-icon";
import SelfReviewNotice from "@/components/ui/self-review-notice";
import { useAssignmentController } from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { useFindTableControllerValue, useListTableControllerValues } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  Repository,
  SelfReviewSettings,
  SubmissionWithGraderResultsAndReview,
  UserRole
} from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Alert, Box, Flex, Heading, HStack, Link, Skeleton, Table } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { CrudFilter, useList } from "@refinedev/core";
import { format, secondsToHours } from "date-fns";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { CommitHistoryDialog } from "./commitHistory";
import ManageGroupWidget from "./manageGroupWidget";

export default function AssignmentPage() {
  const { course_id, assignment_id } = useParams();
  const { private_profile_id } = useClassProfiles();
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
  const repositoriesPredicate = useMemo(() => {
    return (repository: Repository) => repository.assignment_id === Number(assignment_id);
  }, [assignment_id]);
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
  const { data: submissionsData } = useList<SubmissionWithGraderResultsAndReview>({
    resource: "submissions",
    meta: {
      select: "*, grader_results(*), submission_reviews!submissions_grading_review_id_fkey(*)",
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

  // Type assertion needed until migration is applied and types are regenerated
  const autograderRow = autograder?.[0] as
    | (Database["public"]["Functions"]["get_submissions_limits"]["Returns"][number] & {
        submissions_used?: number;
        submissions_remaining?: number;
      })
    | undefined;
  const submissionsPeriod =
    autograderRow?.max_submissions_period_secs != null ? secondsToHours(autograderRow.max_submissions_period_secs) : 0;
  const maxSubmissions = autograderRow?.max_submissions_count;
  const submissionsUsed = autograderRow?.submissions_used ?? 0;
  const submissionsRemaining = autograderRow?.submissions_remaining ?? 0;

  if (!assignment) {
    return <Skeleton height="40" width="100%" />;
  }
  return (
    <Box p={4}>
      <LinkAccount />
      <ResendOrgInvitation />
      <Flex width="100%" alignItems={"center"}>
        <Box>
          <Heading size="lg">{assignment.title}</Heading>
          <HStack>
            <AssignmentDueDate assignment={assignment} showLateTokenButton={true} showTimeZone={true} showDue={true} />
          </HStack>
        </Box>
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
        <></>
      )}
      <Box m={4} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle" maxW="4xl">
        <ManageGroupWidget assignment={assignment} repositories={repositories ?? []} />
      </Box>
      <SelfReviewNotice
        review_settings={review_settings ?? ({} as SelfReviewSettings)}
        assignment={assignment}
        enrollment={enrollment ?? ({} as UserRole)}
        activeSubmission={submissions?.find((sm) => {
          return sm.is_active;
        })}
      />
      {submissionsPeriod && maxSubmissions ? (
        <Box w="925px">
          <Alert.Root
            status={submissionsRemaining === 0 ? "warning" : submissionsRemaining <= 1 ? "warning" : "info"}
            flexDirection="column"
            size="md"
          >
            <Alert.Title>Submission Limit for this assignment</Alert.Title>
            <Alert.Description>
              This assignment has a submission limit of {maxSubmissions} submission{maxSubmissions !== 1 ? "s" : ""} per{" "}
              {submissionsPeriod} hour{submissionsPeriod !== 1 ? "s" : ""}. Submissions that receive a score of
              &quot;0&quot; do NOT count towards the limit.
              <br />
              <strong>
                You have used {submissionsUsed} of {maxSubmissions} submission{maxSubmissions !== 1 ? "s" : ""} this
                period ({submissionsRemaining} remaining).
              </strong>
              {submissionsRemaining === 0 && (
                <strong>
                  Any additional commits that you push to your repository will be ignored, but will still be timestamped
                  and be viewed by course staff.
                </strong>
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
      <Table.Root maxW="2xl">
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
              <Table.Cell data-visual-test="blackout">
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
                    ? `${submission.submission_reviews?.total_score}/${assignment.total_points}`
                    : submission.is_active
                      ? "Pending"
                      : submission.is_not_graded
                        ? "Not for grading"
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
