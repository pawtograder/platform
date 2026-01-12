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
  HStack
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
  section: "recently_due" | "upcoming";
  assignment_id: number;
  title: string;
  due_date: string;
  time_zone: string;
  total_submitters: number;
  graded_submissions: number;
  open_regrade_requests: number;
  closed_or_resolved_regrade_requests: number;
  students_with_valid_extensions: number;
  review_assignments_total: number;
  review_assignments_completed: number;
  review_assignments_incomplete: number;
  rubric_parts_total: number;
  rubric_parts_graded: number;
  rubric_parts_not_graded: number;
};
export default async function InstructorDashboard({ course_id }: { course_id: number }) {
  const supabase = await createClient();

  // Get current user's private profile ID for review assignments
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  if (!user_id) {
    redirect("/");
  }
  const role = await getUserRolesForCourse(course_id, user_id);
  if (!role) {
    redirect("/");
  }
  if (!role.private_profile_id) {
    redirect("/");
  }
  const private_profile_id = role.private_profile_id;

  // Get dashboard metrics via RPC
  const { data: metricsRaw, error: metricsError } = await supabase.rpc("get_instructor_dashboard_metrics", {
    p_class_id: course_id
  });
  if (metricsError) {
    Sentry.captureException(metricsError);
  }
  const metrics = (Array.isArray(metricsRaw) ? metricsRaw : []) as unknown as InstructorDashboardMetricRow[];
  const recentMetrics = metrics.filter((m) => m.section === "recently_due");
  const upcomingMetrics = metrics.filter((m) => m.section === "upcoming");

  const { data: helpRequests, error: helpRequestsError } = await supabase
    .from("help_requests")
    .select("*")
    .eq("class_id", course_id)
    .eq("status", "open")
    .order("created_at", { ascending: true });

  if (helpRequestsError) {
    Sentry.captureException(helpRequestsError);
  }

  // Get review assignments for current user
  const { data: allReviewAssignmentsSummary, error: reviewAssignmentsError } = private_profile_id
    ? await supabase
        .from("review_assignments_summary_by_assignee")
        .select("*")
        .eq("class_id", course_id)
        .eq("assignee_profile_id", private_profile_id)
        .order("soonest_due_date", { ascending: true })
    : { data: null, error: null };

  if (reviewAssignmentsError) {
    Sentry.captureException(reviewAssignmentsError);
  }

  //Show all review assignments that are not completed, and then up to 2 most recent fully completed
  const reviewAssignmentsSummary = allReviewAssignmentsSummary
    ?.filter((summary) => (summary.incomplete_reviews ?? 0) > 0)
    .concat(allReviewAssignmentsSummary?.filter((summary) => (summary.incomplete_reviews ?? 0) === 0).slice(0, 2));
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

      {/* Review Assignments Section */}
      {reviewAssignmentsSummary && reviewAssignmentsSummary.length > 0 && (
        <Box>
          <Heading size="lg" mb={4}>
            Grading Status
          </Heading>
          <Stack spaceY={4}>
            {reviewAssignmentsSummary.map((reviewSummary) => (
              <CompactCardRoot key={`${reviewSummary.assignment_id}`}>
                <CardHeader>
                  <Flex justify="space-between" align="center">
                    <Link href={`/course/${course_id}/manage/assignments/${reviewSummary.assignment_id}`}>
                      <Text fontWeight="semibold">{reviewSummary.assignment_title}</Text>
                    </Link>
                    <Badge colorScheme={(reviewSummary.incomplete_reviews ?? 0) > 0 ? "red" : "green"} size="sm">
                      {(reviewSummary.incomplete_reviews ?? 0) > 0
                        ? `${reviewSummary.incomplete_reviews ?? 0} pending`
                        : "All complete"}
                    </Badge>
                  </Flex>
                </CardHeader>
                <CardBody>
                  <CompactDataListRoot orientation="horizontal">
                    <DataListItem>
                      <DataListItemLabel>Total Reviews</DataListItemLabel>
                      <DataListItemValue>{reviewSummary.total_reviews}</DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Completed</DataListItemLabel>
                      <DataListItemValue>
                        <Flex align="center" gap={2}>
                          <Text>{reviewSummary.completed_reviews}</Text>
                          {reviewSummary.completed_reviews === reviewSummary.total_reviews ? (
                            <Badge colorScheme="green" size="sm">
                              ✓
                            </Badge>
                          ) : null}
                        </Flex>
                      </DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Remaining</DataListItemLabel>
                      <DataListItemValue>
                        {(reviewSummary.incomplete_reviews ?? 0) > 0 ? (
                          <Badge colorScheme="orange" size="sm">
                            {reviewSummary.incomplete_reviews ?? 0}
                          </Badge>
                        ) : (
                          <Text>0</Text>
                        )}
                      </DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Due</DataListItemLabel>
                      <DataListItemValue>
                        <Text fontSize="sm">
                          {reviewSummary.soonest_due_date
                            ? formatInTimeZone(
                                new TZDate(reviewSummary.soonest_due_date),
                                course?.time_zone || "America/New_York",
                                "MMM d, h:mm a"
                              )
                            : "No due date"}
                        </Text>
                      </DataListItemValue>
                    </DataListItem>
                  </CompactDataListRoot>
                </CardBody>
              </CompactCardRoot>
            ))}
          </Stack>
        </Box>
      )}
      <Box>
        <Heading size="lg" mb={4}>
          Recently Due Assignments
        </Heading>
        <Stack spaceY={4}>
          {recentMetrics.map((metric) => {
            return (
              <CompactCardRoot key={metric.assignment_id}>
                <CardHeader>
                  <Flex justify="space-between" align="center">
                    <Link href={`/course/${course_id}/manage/assignments/${metric.assignment_id}`}>
                      <Text fontWeight="semibold">{metric.title}</Text>
                    </Link>
                    <Badge colorScheme="gray" size="sm">
                      Due{" "}
                      {formatInTimeZone(new TZDate(metric.due_date), metric.time_zone || "America/New_York", "MMM d")}
                    </Badge>
                  </Flex>
                </CardHeader>
                <CardBody>
                  <CompactDataListRoot orientation="horizontal">
                    <DataListItem>
                      <DataListItemLabel>Submissions</DataListItemLabel>
                      <DataListItemValue>{metric.total_submitters}</DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Graded/Total</DataListItemLabel>
                      <DataListItemValue>
                        <Flex align="center" gap={2}>
                          <Text>
                            {metric.graded_submissions}/{metric.total_submitters}
                          </Text>
                          {metric.graded_submissions === metric.total_submitters && metric.total_submitters > 0 ? (
                            <Badge colorScheme="green" size="sm">
                              Complete
                            </Badge>
                          ) : (
                            <Badge colorScheme="yellow" size="sm">
                              In Progress
                            </Badge>
                          )}
                        </Flex>
                      </DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Review Assignments</DataListItemLabel>
                      <DataListItemValue>
                        <Flex align="center" gap={2}>
                          <Text>
                            {metric.review_assignments_completed}/{metric.review_assignments_total}
                          </Text>
                          {metric.review_assignments_incomplete > 0 ? (
                            <Badge colorScheme="orange" size="sm">
                              {metric.review_assignments_incomplete} pending
                            </Badge>
                          ) : (
                            <Badge colorScheme="green" size="sm">
                              ✓
                            </Badge>
                          )}
                        </Flex>
                      </DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Rubric parts graded</DataListItemLabel>
                      <DataListItemValue>
                        <Flex align="center" gap={2}>
                          <Text>
                            {metric.rubric_parts_graded}/{metric.rubric_parts_total}
                          </Text>
                          {metric.rubric_parts_not_graded > 0 ? (
                            <Badge colorScheme="yellow" size="sm">
                              {metric.rubric_parts_not_graded} remaining
                            </Badge>
                          ) : (
                            <Badge colorScheme="green" size="sm">
                              ✓
                            </Badge>
                          )}
                        </Flex>
                      </DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Can still submit</DataListItemLabel>
                      <DataListItemValue>
                        {metric.students_with_valid_extensions > 0 ? (
                          <Badge colorScheme="blue" size="sm">
                            {metric.students_with_valid_extensions}
                          </Badge>
                        ) : (
                          <Text>0</Text>
                        )}
                      </DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Regrade requests</DataListItemLabel>
                      <DataListItemValue>
                        <Flex gap={2}>
                          {metric.open_regrade_requests > 0 && (
                            <Badge colorScheme="red" size="sm">
                              {metric.open_regrade_requests} open
                            </Badge>
                          )}
                          {metric.closed_or_resolved_regrade_requests > 0 && (
                            <Badge colorScheme="green" size="sm">
                              {metric.closed_or_resolved_regrade_requests} resolved
                            </Badge>
                          )}
                          {metric.open_regrade_requests === 0 && metric.closed_or_resolved_regrade_requests === 0 && (
                            <Text>None</Text>
                          )}
                        </Flex>
                      </DataListItemValue>
                    </DataListItem>
                  </CompactDataListRoot>
                </CardBody>
              </CompactCardRoot>
            );
          })}
        </Stack>
      </Box>

      <Box>
        <Heading size="lg" mb={4}>
          Upcoming Assignments
        </Heading>
        <Stack spaceY={4}>
          {upcomingMetrics.map((metric) => {
            return (
              <CompactCardRoot key={metric.assignment_id}>
                <CardHeader>
                  <Link href={`/course/${course_id}/manage/assignments/${metric.assignment_id}`}>{metric.title}</Link>
                </CardHeader>
                <CardBody>
                  <CompactDataListRoot orientation="horizontal">
                    <DataListItem>
                      <DataListItemLabel>Due</DataListItemLabel>
                      <DataListItemValue>
                        {metric.due_date
                          ? formatInTimeZone(new TZDate(metric.due_date), metric.time_zone || "America/New_York", "Pp")
                          : "No due date"}
                      </DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Students who have submitted</DataListItemLabel>
                      <DataListItemValue>{metric.total_submitters}</DataListItemValue>
                    </DataListItem>
                  </CompactDataListRoot>
                </CardBody>
              </CompactCardRoot>
            );
          })}
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
