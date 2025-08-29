"use client";
import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { AssignmentDueDate } from "@/components/ui/assignment-due-date";
import Markdown from "@/components/ui/markdown";
import SelfReviewNotice from "@/components/ui/self-review-notice";
import useAuthState from "@/hooks/useAuthState";
import type {
  Assignment,
  Repository,
  SelfReviewSettings,
  SubmissionWithGraderResultsAndReview,
  UserRole,
  UserRoleWithCourse
} from "@/utils/supabase/DatabaseTypes";
import { Alert, Box, Flex, Heading, HStack, Link, Skeleton, Table } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { type CrudFilter, useList } from "@refinedev/core";
import { format } from "date-fns";
import { useParams } from "next/navigation";
import { CommitHistoryDialog } from "./commitHistory";
import ManageGroupWidget from "./manageGroupWidget";
import { NotGradedSubmissionIcon } from "@/components/ui/not-graded-submission-icon";
import LinkAccount from "@/components/github/link-account";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";

export default function AssignmentPage() {
  const { course_id, assignment_id } = useParams();
  const { user } = useAuthState();
  const { data: enrollmentData } = useList<UserRoleWithCourse>({
    resource: "user_roles",
    meta: {
      select: "*, classes(time_zone)",
      limit: 1
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "user_id", operator: "eq", value: user?.id }
    ],
    queryOptions: {
      enabled: !!user
    }
  });
  const enrollment = enrollmentData && enrollmentData.data.length > 0 ? enrollmentData.data[0] : null;

  const { data: assignmentData } = useList<Assignment>({
    resource: "assignments",
    meta: {
      select: "*",
      limit: 1
    },
    filters: [
      {
        field: "id",
        operator: "eq",
        value: assignment_id
      }
    ]
  });
  const { data: submissionsData } = useList<SubmissionWithGraderResultsAndReview>({
    resource: "submissions",
    meta: {
      select: "*, grader_results(*), submission_reviews!submissions_grading_review_id_fkey(*)",
      order: "created_at, { ascending: false }"
    },
    pagination: {
      pageSize: 500
    },
    filters: [{ field: "assignment_id", operator: "eq", value: assignment_id }],
    sorters: [
      {
        field: "created_at",
        order: "desc"
      }
    ]
  });
  const { data: groupData } = useList({
    resource: "assignment_groups_members",
    meta: {
      select: "*, assignment_groups!id(*)"
    },
    filters: [
      {
        field: "assignment_id",
        operator: "eq",
        value: assignment_id
      },
      {
        field: "profile_id",
        operator: "eq",
        value: enrollment?.private_profile_id
      }
    ],
    queryOptions: {
      enabled: assignmentData?.data?.[0]?.group_config !== "individual" && !!enrollment?.private_profile_id
    }
  });

  const assignment_group_id: number | undefined = groupData?.data?.[0]?.["assignment_group_id"];

  const filters: CrudFilter[] = [{ field: "assignment_id", operator: "eq", value: assignment_id }];
  if (assignment_group_id) {
    filters.push({ field: "assignment_group_id", operator: "eq", value: assignment_group_id });
  } else if (enrollment?.private_profile_id) {
    filters.push({ field: "profile_id", operator: "eq", value: enrollment?.private_profile_id });
  }
  const { data: repositoriesData } = useList<Repository>({ resource: "repositories", filters });

  const { data: reviewSettingsData } = useList<SelfReviewSettings>({
    resource: "assignment_self_review_settings",
    meta: {
      select: "*",
      limit: 1
    },
    filters: [{ field: "id", operator: "eq", value: assignmentData?.data?.[0]?.self_review_setting_id }],
    queryOptions: {
      enabled: !!assignmentData && assignmentData.data.length !== 0
    }
  });

  if (!assignmentData || assignmentData.data.length === 0) {
    return <div>Assignment not found</div>;
  }

  const assignment = assignmentData.data[0]!;
  const repositories = repositoriesData?.data;
  const submissions = submissionsData?.data;
  const review_settings = reviewSettingsData && reviewSettingsData.data.length > 0 ? reviewSettingsData.data[0] : null;
  const timeZone = enrollment?.classes?.time_zone || "America/New_York";

  if (!enrollment) {
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

      <Heading size="md">Submission History</Heading>
      <CommitHistoryDialog
        assignment={assignment}
        assignment_group_id={assignment_group_id}
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
                  {!assignment_group_id || submission.assignment_group_id
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
