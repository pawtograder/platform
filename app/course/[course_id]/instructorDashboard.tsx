import { createClient } from "@/utils/supabase/server";
import * as Sentry from "@sentry/nextjs";
import {
  Box,
  CardBody,
  CardHeader,
  CardRoot,
  DataListItem,
  DataListItemLabel,
  DataListItemValue,
  DataListRoot,
  Heading,
  Stack,
  VStack,
  Badge,
  Flex,
  Text,
  HStack,
  Table
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { formatInTimeZone } from "date-fns-tz";
import Link from "next/link";
import { Database } from "@/utils/supabase/SupabaseTypes";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";
import { getUserRolesForCourse } from "@/lib/ssrUtils";
import LinkAccount from "@/components/github/link-account";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import CalendarScheduleSummary from "@/components/calendar/calendar-schedule-summary";
import { DiscussionSummary } from "@/components/discussion/DiscussionSummary";
import { AssignedLabSections } from "@/components/discussion/AssignedLabSections";

// Custom styled DataListRoot with reduced vertical spacing
const CompactDataListRoot = ({ children, ...props }: React.ComponentProps<typeof DataListRoot>) => (
  <DataListRoot
    {...props}
    css={{
      gap: 1,
      "& > *": {
        marginBottom: "0 !important",
        paddingBottom: "0 !important"
      },
      "& > *:last-child": {
        marginBottom: "0 !important",
        paddingBottom: "0 !important"
      }
    }}
  >
    {children}
  </DataListRoot>
);

// Custom styled CardRoot with reduced padding
const CompactCardRoot = ({ children, ...props }: React.ComponentProps<typeof CardRoot>) => (
  <CardRoot
    {...props}
    css={{
      "& .chakra-card__header": {
        padding: "0.75rem !important"
      },
      "& .chakra-card__body": {
        padding: "0.75rem !important",
        paddingTop: "0 !important"
      }
    }}
  >
    {children}
  </CardRoot>
);

type InstructorDashboardMetricRow = {
  section: "past_due" | "upcoming" | "undated";
  assignment_id: number;
  title: string;
  due_date: string | null;
  time_zone: string;
  total_submitters: number;
  graded_submissions: number;
  open_regrade_requests: number;
  closed_or_resolved_regrade_requests: number;
  students_with_valid_extensions: number;
  review_assignments_total: number;
  review_assignments_completed: number;
  review_assignments_incomplete: number;
  submission_reviews_total: number;
  submission_reviews_completed: number;
  submission_reviews_incomplete: number;
  class_student_count: number;
  students_without_submissions: number;
};
export default async function InstructorDashboard({ course_id }: { course_id: number }) {
  const supabase = await createClient();

  // Validate current user can access course dashboard
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }
  const role = await getUserRolesForCourse(course_id, user_id);
  if (!role) {
    redirect("/");
  }

  // Get dashboard metrics via RPC
  const { data: metricsRaw, error: metricsError } = await supabase.rpc("get_instructor_dashboard_overview_metrics", {
    p_class_id: course_id
  });
  if (metricsError) {
    Sentry.captureException(metricsError);
  }
  const metrics = (Array.isArray(metricsRaw) ? metricsRaw : []) as unknown as InstructorDashboardMetricRow[];
  const needsAttention = metrics.filter(
    (m) => m.submission_reviews_incomplete > 0 || m.review_assignments_incomplete > 0 || m.open_regrade_requests > 0
  );
  const needsAttentionAssignmentIds = new Set(needsAttention.map((m) => m.assignment_id));
  const upcomingNoBlockingWork = metrics.filter(
    (m) => m.section === "upcoming" && !needsAttentionAssignmentIds.has(m.assignment_id)
  );
  const completeOrStable = metrics.filter(
    (m) =>
      m.section !== "upcoming" &&
      !needsAttentionAssignmentIds.has(m.assignment_id) &&
      m.submission_reviews_incomplete === 0 &&
      m.review_assignments_incomplete === 0
  );
  const totalIncompleteSubmissionReviews = metrics.reduce((acc, m) => acc + (m.submission_reviews_incomplete ?? 0), 0);
  const totalIncompleteReviewAssignments = metrics.reduce((acc, m) => acc + (m.review_assignments_incomplete ?? 0), 0);
  const totalOpenRegrades = metrics.reduce((acc, m) => acc + (m.open_regrade_requests ?? 0), 0);
  const totalStudentsMissingSubmission = metrics.reduce((acc, m) => acc + (m.students_without_submissions ?? 0), 0);

  const { data: helpRequests, error: helpRequestsError } = await supabase
    .from("help_requests")
    .select("*")
    .eq("class_id", course_id)
    .eq("status", "open")
    .order("created_at", { ascending: true });

  if (helpRequestsError) {
    Sentry.captureException(helpRequestsError);
  }
  const { data: course, error: courseError } = await supabase
    .from("classes")
    .select("time_zone, office_hours_ics_url, events_ics_url")
    .eq("id", course_id)
    .single();

  if (courseError) {
    Sentry.captureException(courseError);
  }
  const identities = await supabase.auth.getUserIdentities();
  const githubIdentity = identities.data?.identities.find((identity) => identity.provider === "github");

  // Get workflow run statistics using the secure RPC function
  const { data: workflowStatsHour, error: workflowStatsHourError } = await supabase.rpc("get_workflow_statistics", {
    p_class_id: course_id,
    p_duration_hours: 1
  });

  if (workflowStatsHourError) {
    Sentry.captureException(workflowStatsHourError);
  }

  const { data: workflowStatsDay, error: workflowStatsDayError } = await supabase.rpc("get_workflow_statistics", {
    p_class_id: course_id,
    p_duration_hours: 24
  });

  if (workflowStatsDayError) {
    Sentry.captureException(workflowStatsDayError);
  }

  // Get the 5 most recent errors with details
  const { data: recentErrors, error: recentErrorsError } = await supabase
    .from("workflow_run_error")
    .select(
      `
      id,
      name,
      created_at,
      submissions!submission_id(
        profiles!profile_id(name, id),
        assignments!assignment_id(title),
        assignment_groups!assignment_group_id(name)
      )
    `
    )
    .eq("class_id", course_id)
    .order("created_at", { ascending: false })
    .limit(5);

  if (recentErrorsError) {
    Sentry.captureException(recentErrorsError);
  }

  // Extract workflow statistics from RPC response
  const extractWorkflowStats = (
    rpcResponse: Database["public"]["Functions"]["get_workflow_statistics"]["Returns"] | null
  ) => {
    if (!rpcResponse) {
      return {
        total: 0,
        errorCount: 0,
        avgQueue: 0,
        avgRun: 0,
        errorRate: 0
      };
    }

    const stats = rpcResponse[0];
    return {
      total: Number(stats.total_runs) || 0,
      errorCount: Number(stats.error_count) || 0,
      avgQueue: Math.round(Number(stats.avg_queue_time_seconds) || 0),
      avgRun: Math.round(Number(stats.avg_run_time_seconds) || 0),
      errorRate: Number(stats.error_rate) || 0
    };
  };

  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
  };

  const hourStats = extractWorkflowStats(workflowStatsHour);
  const dayStats = extractWorkflowStats(workflowStatsDay);

  const hasCalendar = course?.office_hours_ics_url || course?.events_ics_url;
  const formatDashboardDueDate = (metric: InstructorDashboardMetricRow) =>
    metric.due_date
      ? formatInTimeZone(
          new TZDate(metric.due_date),
          metric.time_zone || course?.time_zone || "America/New_York",
          "MMM d, h:mm a"
        )
      : "No due date";
  const renderAssignmentOverviewTable = (title: string, rows: InstructorDashboardMetricRow[], emptyMessage: string) => (
    <Box>
      <Heading size="md" mb={2}>
        {title}
      </Heading>
      {rows.length === 0 ? (
        <Text fontSize="sm" color="fg.muted">
          {emptyMessage}
        </Text>
      ) : (
        <Box border="1px solid" borderColor="border.subtle" borderRadius="md" overflowX="auto">
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Assignment</Table.ColumnHeader>
                <Table.ColumnHeader>Due</Table.ColumnHeader>
                <Table.ColumnHeader>Submitted Students</Table.ColumnHeader>
                <Table.ColumnHeader>Submission Reviews</Table.ColumnHeader>
                <Table.ColumnHeader>Review Assignments</Table.ColumnHeader>
                <Table.ColumnHeader>Regrades / Extensions</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((metric) => (
                <Table.Row key={metric.assignment_id}>
                  <Table.Cell>
                    <Link href={`/course/${course_id}/manage/assignments/${metric.assignment_id}`}>
                      <Text fontWeight="semibold">{metric.title}</Text>
                    </Link>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex align="center" gap={2} wrap="wrap">
                      <Text>{formatDashboardDueDate(metric)}</Text>
                      {metric.section === "past_due" && (
                        <Badge colorScheme="orange" size="sm">
                          Past due
                        </Badge>
                      )}
                      {metric.section === "upcoming" && (
                        <Badge colorScheme="blue" size="sm">
                          Upcoming
                        </Badge>
                      )}
                      {metric.section === "undated" && (
                        <Badge colorScheme="gray" size="sm">
                          Undated
                        </Badge>
                      )}
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex align="center" gap={2} wrap="wrap">
                      <Text>
                        {metric.total_submitters}/{metric.class_student_count}
                      </Text>
                      {metric.students_without_submissions > 0 ? (
                        <Badge colorScheme="yellow" size="sm">
                          {metric.students_without_submissions} missing
                        </Badge>
                      ) : (
                        <Badge colorScheme="green" size="sm">
                          All submitted
                        </Badge>
                      )}
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex align="center" gap={2} wrap="wrap">
                      <Text>
                        {metric.submission_reviews_completed}/{metric.submission_reviews_total}
                      </Text>
                      {metric.submission_reviews_incomplete > 0 ? (
                        <Badge colorScheme="orange" size="sm">
                          {metric.submission_reviews_incomplete} incomplete
                        </Badge>
                      ) : (
                        <Badge colorScheme="green" size="sm">
                          Complete
                        </Badge>
                      )}
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex align="center" gap={2} wrap="wrap">
                      <Text>
                        {metric.review_assignments_completed}/{metric.review_assignments_total}
                      </Text>
                      {metric.review_assignments_incomplete > 0 ? (
                        <Badge colorScheme="red" size="sm">
                          {metric.review_assignments_incomplete} incomplete
                        </Badge>
                      ) : (
                        <Badge colorScheme="green" size="sm">
                          Complete
                        </Badge>
                      )}
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex align="center" gap={2} wrap="wrap">
                      {metric.open_regrade_requests > 0 ? (
                        <Badge colorScheme="red" size="sm">
                          {metric.open_regrade_requests} open
                        </Badge>
                      ) : (
                        <Badge colorScheme="green" size="sm">
                          0 open
                        </Badge>
                      )}
                      {metric.closed_or_resolved_regrade_requests > 0 && (
                        <Badge colorScheme="green" size="sm">
                          {metric.closed_or_resolved_regrade_requests} resolved
                        </Badge>
                      )}
                      {metric.students_with_valid_extensions > 0 && (
                        <Badge colorScheme="blue" size="sm">
                          {metric.students_with_valid_extensions} with extensions
                        </Badge>
                      )}
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      )}
    </Box>
  );

  return (
    <VStack spaceY={0} align="stretch" p={2}>
      {!githubIdentity && <LinkAccount />}
      <ResendOrgInvitation />
      {/* Calendar Schedule Section */}
      {hasCalendar && (
        <Box>
          <CalendarScheduleSummary />
        </Box>
      )}

      {/* Assigned Lab Sections Section */}
      <AssignedLabSections />

      <Box>
        <Heading size="lg" mb={2}>
          Assignment Grading Overview
        </Heading>
        <Text mb={4} color="fg.muted" fontSize="sm">
          One RPC now loads all assignment metrics. Incomplete submission reviews and incomplete review assignments are
          tracked separately (review assignments may be higher when multiple graders are assigned to one submission).
        </Text>
        <Stack direction={{ base: "column", md: "row" }} spaceY={0} gap={3} mb={4}>
          <CompactCardRoot flex={1}>
            <CardHeader>
              <Text fontWeight="semibold">Assignments Needing Attention</Text>
            </CardHeader>
            <CardBody>
              <Text fontSize="2xl" fontWeight="bold">
                {needsAttention.length}
              </Text>
            </CardBody>
          </CompactCardRoot>
          <CompactCardRoot flex={1}>
            <CardHeader>
              <Text fontWeight="semibold">Incomplete Submission Reviews</Text>
            </CardHeader>
            <CardBody>
              <Text fontSize="2xl" fontWeight="bold">
                {totalIncompleteSubmissionReviews}
              </Text>
            </CardBody>
          </CompactCardRoot>
          <CompactCardRoot flex={1}>
            <CardHeader>
              <Text fontWeight="semibold">Incomplete Review Assignments</Text>
            </CardHeader>
            <CardBody>
              <Text fontSize="2xl" fontWeight="bold">
                {totalIncompleteReviewAssignments}
              </Text>
            </CardBody>
          </CompactCardRoot>
          <CompactCardRoot flex={1}>
            <CardHeader>
              <Text fontWeight="semibold">Open Regrade Requests</Text>
            </CardHeader>
            <CardBody>
              <Text fontSize="2xl" fontWeight="bold">
                {totalOpenRegrades}
              </Text>
              {totalStudentsMissingSubmission > 0 && (
                <Text fontSize="xs" color="fg.muted">
                  {totalStudentsMissingSubmission} missing submissions across assignments
                </Text>
              )}
            </CardBody>
          </CompactCardRoot>
        </Stack>
        <Stack spaceY={4}>
          {renderAssignmentOverviewTable(
            "Needs attention",
            needsAttention,
            "No assignments currently have incomplete reviews, pending review assignments, or open regrade requests."
          )}
          {renderAssignmentOverviewTable(
            "Upcoming with no blocking work",
            upcomingNoBlockingWork,
            "No upcoming assignments are currently in a clean state."
          )}
          {renderAssignmentOverviewTable(
            "Complete or stable",
            completeOrStable,
            "No past-due/undated assignments are currently fully settled."
          )}
        </Stack>
      </Box>

      {/* Discussion Activity Summary */}
      {user_id && <DiscussionSummary courseId={course_id} userId={user_id} />}

      <Box>
        <Heading size="lg" mb={4}>
          Open Office Hours Requests
        </Heading>
        <Stack spaceY={4}>
          {helpRequests?.map((request) => (
            <CardRoot key={request.id}>
              <CardHeader>
                <Link href={`/course/${course_id}/office-hours/${request.id}`}>{request.request}</Link>
              </CardHeader>
              <CardBody>Requested: {new Date(request.created_at).toLocaleString()}</CardBody>
            </CardRoot>
          ))}
        </Stack>
      </Box>

      <Box>
        <Heading size="lg" mb={4}>
          Workflow Runs Summary
        </Heading>
        <Stack spaceY={4}>
          <CompactCardRoot>
            <CardHeader>
              <Flex justify="space-between" align="center">
                <Link href={`/course/${course_id}/manage/workflow-runs`}>
                  <Text fontWeight="semibold">Last Hour</Text>
                </Link>
                <Badge colorScheme={hourStats.errorCount > 0 ? "red" : "green"} size="sm">
                  {hourStats.errorCount > 0 ? `${hourStats.errorCount} errors` : "No errors"}
                </Badge>
              </Flex>
            </CardHeader>
            <CardBody>
              <CompactDataListRoot orientation="horizontal">
                <DataListItem>
                  <DataListItemLabel>Total Runs</DataListItemLabel>
                  <DataListItemValue>{hourStats.total}</DataListItemValue>
                </DataListItem>
                <DataListItem>
                  <DataListItemLabel>Avg Queue Time</DataListItemLabel>
                  <DataListItemValue>
                    <Text
                      color={
                        hourStats.avgQueue > 300 ? "red.600" : hourStats.avgQueue > 60 ? "orange.600" : "green.600"
                      }
                    >
                      {formatTime(hourStats.avgQueue)}
                    </Text>
                  </DataListItemValue>
                </DataListItem>
                <DataListItem>
                  <DataListItemLabel>Avg Run Time</DataListItemLabel>
                  <DataListItemValue>
                    <Text
                      color={hourStats.avgRun > 600 ? "red.600" : hourStats.avgRun > 120 ? "orange.600" : "green.600"}
                    >
                      {formatTime(hourStats.avgRun)}
                    </Text>
                  </DataListItemValue>
                </DataListItem>
                <DataListItem>
                  <DataListItemLabel>Error Rate</DataListItemLabel>
                  <DataListItemValue>
                    <Text
                      color={
                        hourStats.errorRate > 10 ? "red.600" : hourStats.errorRate > 5 ? "orange.600" : "green.600"
                      }
                    >
                      {hourStats.errorRate.toFixed(1)}%
                    </Text>
                  </DataListItemValue>
                </DataListItem>
              </CompactDataListRoot>
            </CardBody>
          </CompactCardRoot>

          <CompactCardRoot>
            <CardHeader>
              <Flex justify="space-between" align="center">
                <Link href={`/course/${course_id}/manage/workflow-runs`}>
                  <Text fontWeight="semibold">Last 24 Hours</Text>
                </Link>
                <Badge colorScheme={dayStats.errorCount > 0 ? "red" : "green"} size="sm">
                  {dayStats.errorCount > 0 ? `${dayStats.errorCount} errors` : "No errors"}
                </Badge>
              </Flex>
            </CardHeader>
            <CardBody>
              <CompactDataListRoot orientation="horizontal">
                <DataListItem>
                  <DataListItemLabel>Total Runs</DataListItemLabel>
                  <DataListItemValue>{dayStats.total}</DataListItemValue>
                </DataListItem>
                <DataListItem>
                  <DataListItemLabel>Avg Queue Time</DataListItemLabel>
                  <DataListItemValue>
                    <Text
                      color={dayStats.avgQueue > 300 ? "red.600" : dayStats.avgQueue > 60 ? "orange.600" : "green.600"}
                    >
                      {formatTime(dayStats.avgQueue)}
                    </Text>
                  </DataListItemValue>
                </DataListItem>
                <DataListItem>
                  <DataListItemLabel>Avg Run Time</DataListItemLabel>
                  <DataListItemValue>
                    <Text
                      color={dayStats.avgRun > 600 ? "red.600" : dayStats.avgRun > 120 ? "orange.600" : "green.600"}
                    >
                      {formatTime(dayStats.avgRun)}
                    </Text>
                  </DataListItemValue>
                </DataListItem>
                <DataListItem>
                  <DataListItemLabel>Error Rate</DataListItemLabel>
                  <DataListItemValue>
                    <Text
                      color={dayStats.errorRate > 10 ? "red.600" : dayStats.errorRate > 5 ? "orange.600" : "green.600"}
                    >
                      {dayStats.errorRate.toFixed(1)}%
                    </Text>
                  </DataListItemValue>
                </DataListItem>
              </CompactDataListRoot>
            </CardBody>
          </CompactCardRoot>

          {/* Summary message */}
          {hourStats.errorCount === 0 && dayStats.errorCount === 0 ? (
            <CompactCardRoot>
              <CardBody>
                <HStack justify="center" align="center" py={2}>
                  <Text color="green.600" fontWeight="medium">
                    ✓ All workflows running smoothly with no errors in the last 24 hours
                  </Text>
                </HStack>
              </CardBody>
            </CompactCardRoot>
          ) : (
            <CompactCardRoot>
              <CardHeader>
                <Flex justify="space-between" align="center">
                  <Text fontWeight="semibold">Recent Errors</Text>
                  <Link href={`/course/${course_id}/manage/workflow-runs/errors`}>
                    <Badge colorScheme="orange" size="sm">
                      View All
                    </Badge>
                  </Link>
                </Flex>
              </CardHeader>
              <CardBody>
                <Stack spaceY={2}>
                  {recentErrors && recentErrors.length > 0 ? (
                    recentErrors.map((error) => {
                      const submission = error.submissions;
                      const studentName =
                        submission?.profiles?.name || submission?.assignment_groups?.name || "Unknown";
                      const assignmentTitle = submission?.assignments?.title || "Unknown Assignment";
                      const timeAgo = new Date(error.created_at).toLocaleString();

                      return (
                        <Box key={error.id} p={2} border="1px solid" borderColor="border.subtle" borderRadius="md">
                          <Flex justify="space-between" align="start" mb={1}>
                            <Text fontSize="sm" fontWeight="medium" color="red.600">
                              {error.name}
                            </Text>
                            <Text fontSize="xs" color="fg.muted">
                              {timeAgo}
                            </Text>
                          </Flex>
                          <Text fontSize="sm" color="fg.muted">
                            {studentName} • {assignmentTitle}
                          </Text>
                        </Box>
                      );
                    })
                  ) : (
                    <Text fontSize="sm" color="fg.muted" textAlign="center">
                      No recent errors to display
                    </Text>
                  )}
                </Stack>
              </CardBody>
            </CompactCardRoot>
          )}
        </Stack>
      </Box>
    </VStack>
  );
}
