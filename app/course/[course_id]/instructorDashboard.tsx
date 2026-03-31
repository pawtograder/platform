import CalendarScheduleSummary from "@/components/calendar/calendar-schedule-summary";
import { AssignedLabSections } from "@/components/discussion/AssignedLabSections";
import { DiscussionSummary } from "@/components/discussion/DiscussionSummary";
import LinkAccount from "@/components/github/link-account";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { getUserRolesForCourse } from "@/lib/ssrUtils";
import { createClient } from "@/utils/supabase/server";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { TZDate } from "@date-fns/tz";
import {
  Badge,
  Box,
  CardBody,
  CardHeader,
  CardRoot,
  DataListItem,
  DataListItemLabel,
  DataListItemValue,
  DataListRoot,
  Flex,
  Heading,
  HStack,
  Stack,
  Text,
  VStack,
  Table
} from "@chakra-ui/react";
import * as Sentry from "@sentry/nextjs";
import { formatInTimeZone } from "date-fns-tz";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

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

type DashboardBadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

const dashboardBadgeStyles: Record<
  DashboardBadgeTone,
  {
    bg: string;
    color: string;
    borderColor: string;
    darkBg: string;
    darkColor: string;
    darkBorderColor: string;
  }
> = {
  success: {
    bg: "green.100",
    color: "green.800",
    borderColor: "green.200",
    darkBg: "green.900",
    darkColor: "green.200",
    darkBorderColor: "green.700"
  },
  warning: {
    bg: "orange.100",
    color: "orange.800",
    borderColor: "orange.200",
    darkBg: "orange.900",
    darkColor: "orange.200",
    darkBorderColor: "orange.700"
  },
  danger: {
    bg: "red.100",
    color: "red.800",
    borderColor: "red.200",
    darkBg: "red.900",
    darkColor: "red.200",
    darkBorderColor: "red.700"
  },
  info: {
    bg: "blue.100",
    color: "blue.800",
    borderColor: "blue.200",
    darkBg: "blue.900",
    darkColor: "blue.200",
    darkBorderColor: "blue.700"
  },
  neutral: {
    bg: "gray.100",
    color: "gray.800",
    borderColor: "gray.200",
    darkBg: "gray.800",
    darkColor: "gray.200",
    darkBorderColor: "gray.600"
  }
};

const DashboardBadge = ({
  tone,
  children,
  ...props
}: { tone: DashboardBadgeTone; children: React.ReactNode } & Omit<
  React.ComponentProps<typeof Badge>,
  "colorScheme" | "colorPalette"
>) => {
  const style = dashboardBadgeStyles[tone];
  return (
    <Badge
      {...props}
      size={props.size ?? "sm"}
      borderWidth="1px"
      bg={style.bg}
      color={style.color}
      borderColor={style.borderColor}
      _dark={{
        bg: style.darkBg,
        color: style.darkColor,
        borderColor: style.darkBorderColor
      }}
    >
      {children}
    </Badge>
  );
};

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
  grades_released_count: number;
  grades_unreleased_count: number;
  grades_release_status: "no_submissions" | "not_released" | "partially_released" | "fully_released";
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

  const [
    { data: metricsRaw, error: metricsError },
    { data: helpRequests, error: helpRequestsError },
    { data: course, error: courseError },
    { data: surveysForDashboardRaw, error: surveysDashboardError },
    identities,
    { data: workflowStatsHour, error: workflowStatsHourError },
    { data: workflowStatsDay, error: workflowStatsDayError },
    { data: recentErrors, error: recentErrorsError }
  ] = await Promise.all([
    supabase.rpc("get_instructor_dashboard_overview_metrics", { p_class_id: course_id }),
    supabase
      .from("help_requests")
      .select("*")
      .eq("class_id", course_id)
      .eq("status", "open")
      .order("created_at", { ascending: true }),
    supabase.from("classes").select("time_zone, office_hours_ics_url, events_ics_url").eq("id", course_id).single(),
    supabase
      .from("surveys")
      .select("id, survey_id, title, status, due_date, updated_at")
      .eq("class_id", course_id)
      .is("deleted_at", null)
      .in("status", ["published", "closed"]),
    supabase.auth.getUserIdentities(),
    supabase.rpc("get_workflow_statistics", { p_class_id: course_id, p_duration_hours: 1 }),
    supabase.rpc("get_workflow_statistics", { p_class_id: course_id, p_duration_hours: 24 }),
    supabase
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
      .limit(5)
  ]);

  if (metricsError) {
    Sentry.captureException(metricsError);
  }
  if (helpRequestsError) {
    Sentry.captureException(helpRequestsError);
  }
  if (courseError) {
    Sentry.captureException(courseError);
  }
  if (surveysDashboardError) {
    Sentry.captureException(surveysDashboardError);
  }
  if (workflowStatsHourError) {
    Sentry.captureException(workflowStatsHourError);
  }
  if (workflowStatsDayError) {
    Sentry.captureException(workflowStatsDayError);
  }
  if (recentErrorsError) {
    Sentry.captureException(recentErrorsError);
  }

  const metricsLoadFailed = Boolean(metricsError);
  const metrics = (!metricsLoadFailed && Array.isArray(metricsRaw)
    ? metricsRaw
    : []) as unknown as InstructorDashboardMetricRow[];
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
  const fullyReleasedAssignments = metrics.filter((m) => m.grades_release_status === "fully_released").length;
  const partiallyReleasedAssignments = metrics.filter((m) => m.grades_release_status === "partially_released").length;
  const unreleasedAssignments = metrics.filter((m) => m.grades_release_status === "not_released").length;
  const noSubmissionAssignments = metrics.filter((m) => m.grades_release_status === "no_submissions").length;
  const releasableAssignments = metrics.length - noSubmissionAssignments;

  const githubIdentity = identities.data?.identities.find((identity) => identity.provider === "github");

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
                <Table.ColumnHeader>Grading due</Table.ColumnHeader>
                <Table.ColumnHeader>Submitted Students</Table.ColumnHeader>
                <Table.ColumnHeader>Submission Reviews</Table.ColumnHeader>
                <Table.ColumnHeader>Review Assignments</Table.ColumnHeader>
                <Table.ColumnHeader>Grades released</Table.ColumnHeader>
                <Table.ColumnHeader>Regrades / Extensions</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((metric) => {
                const assignmentRootHref = `/course/${course_id}/manage/assignments/${metric.assignment_id}`;
                const submissionsHref = assignmentRootHref;
                const assignmentsTableHref = `${assignmentRootHref}?tab=all-submissions`;
                const gradingDashboardHref = `${assignmentRootHref}/grading-progress`;
                const reviewAssignmentsHref = `${assignmentRootHref}/reviews`;
                const regradesHref = `${assignmentRootHref}/regrade-requests`;
                const dueDateExceptionsHref = `${assignmentRootHref}/due-date-exceptions`;

                return (
                  <Table.Row key={metric.assignment_id}>
                    <Table.Cell>
                      <Stack gap={1}>
                        <Link href={assignmentRootHref}>
                          <Text fontWeight="semibold">{metric.title}</Text>
                        </Link>
                        <Flex gap={2} wrap="wrap">
                          <Link href={gradingDashboardHref}>
                            <Text fontSize="xs" color="blue.600">
                              Grading dashboard
                            </Text>
                          </Link>
                          <Link href={submissionsHref}>
                            <Text fontSize="xs" color="blue.600">
                              Submissions
                            </Text>
                          </Link>
                          <Link href={regradesHref}>
                            <Text fontSize="xs" color="blue.600">
                              Regrade requests
                            </Text>
                          </Link>
                          <Link href={dueDateExceptionsHref}>
                            <Text fontSize="xs" color="blue.600">
                              Due date exceptions
                            </Text>
                          </Link>
                        </Flex>
                      </Stack>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex align="center" gap={2} wrap="wrap">
                        <Link href={dueDateExceptionsHref}>
                          <Text>{formatDashboardDueDate(metric)}</Text>
                        </Link>
                        {metric.section === "past_due" && (
                          <DashboardBadge tone="warning">Past grading due</DashboardBadge>
                        )}
                        {metric.section === "upcoming" && (
                          <DashboardBadge tone="info">Upcoming grading due</DashboardBadge>
                        )}
                        {metric.section === "undated" && (
                          <DashboardBadge tone="neutral">No grading due date</DashboardBadge>
                        )}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex align="center" gap={2} wrap="wrap">
                        <Link href={submissionsHref}>
                          <Text>
                            {metric.total_submitters}/{metric.class_student_count}
                          </Text>
                        </Link>
                        {metric.students_without_submissions > 0 ? (
                          <DashboardBadge tone="warning">{metric.students_without_submissions} missing</DashboardBadge>
                        ) : (
                          <DashboardBadge tone="success">All submitted</DashboardBadge>
                        )}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex align="center" gap={2} wrap="wrap">
                        <Link href={assignmentsTableHref}>
                          <Text>
                            {metric.submission_reviews_completed}/{metric.submission_reviews_total}
                          </Text>
                        </Link>
                        {metric.submission_reviews_incomplete > 0 ? (
                          <Link href={assignmentsTableHref}>
                            <DashboardBadge tone="warning">
                              {metric.submission_reviews_incomplete} incomplete
                            </DashboardBadge>
                          </Link>
                        ) : (
                          <DashboardBadge tone="success">Complete</DashboardBadge>
                        )}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex align="center" gap={2} wrap="wrap">
                        <Link href={reviewAssignmentsHref}>
                          <Text>
                            {metric.review_assignments_completed}/{metric.review_assignments_total}
                          </Text>
                        </Link>
                        {metric.review_assignments_incomplete > 0 ? (
                          <DashboardBadge tone="danger">
                            {metric.review_assignments_incomplete} incomplete
                          </DashboardBadge>
                        ) : (
                          <DashboardBadge tone="success">Complete</DashboardBadge>
                        )}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex align="center" gap={2} wrap="wrap">
                        <Link href={assignmentRootHref}>
                          <Text>
                            {metric.grades_released_count}/
                            {metric.grades_released_count + metric.grades_unreleased_count}
                          </Text>
                        </Link>
                        {metric.grades_release_status === "fully_released" && (
                          <DashboardBadge tone="success">Fully released</DashboardBadge>
                        )}
                        {metric.grades_release_status === "partially_released" && (
                          <DashboardBadge tone="warning">Partial release</DashboardBadge>
                        )}
                        {metric.grades_release_status === "not_released" && (
                          <DashboardBadge tone="neutral">Not released</DashboardBadge>
                        )}
                        {metric.grades_release_status === "no_submissions" && (
                          <DashboardBadge tone="neutral">No submissions</DashboardBadge>
                        )}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex align="center" gap={2} wrap="wrap">
                        <Link href={regradesHref}>
                          {metric.open_regrade_requests > 0 ? (
                            <DashboardBadge tone="danger">{metric.open_regrade_requests} open</DashboardBadge>
                          ) : (
                            <DashboardBadge tone="success">0 open</DashboardBadge>
                          )}
                        </Link>
                        {metric.closed_or_resolved_regrade_requests > 0 && (
                          <Link href={regradesHref}>
                            <DashboardBadge tone="success">
                              {metric.closed_or_resolved_regrade_requests} resolved
                            </DashboardBadge>
                          </Link>
                        )}
                        {metric.students_with_valid_extensions > 0 && (
                          <Link href={dueDateExceptionsHref}>
                            <DashboardBadge tone="info">
                              {metric.students_with_valid_extensions} with extensions
                            </DashboardBadge>
                          </Link>
                        )}
                      </Flex>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        </Box>
      )}
    </Box>
  );

  type StaffSurveyDashRow = {
    id: string;
    survey_id: string;
    title: string | null;
    status: string;
    due_date: string | null;
    updated_at: string | null;
  };

  const staffSurveys = (surveysForDashboardRaw ?? []) as StaffSurveyDashRow[];
  const nowMs = Date.now();
  const surveysOpenCollecting = staffSurveys.filter(
    (s) => s.status === "published" && (!s.due_date || new Date(s.due_date).getTime() >= nowMs)
  );
  const openSurveyIdSet = new Set(surveysOpenCollecting.map((s) => s.id));
  const surveysRecentThree = [...staffSurveys.filter((s) => !openSurveyIdSet.has(s.id))]
    .sort((a, b) => {
      const aKey = new Date(a.due_date ?? a.updated_at ?? 0).getTime();
      const bKey = new Date(b.due_date ?? b.updated_at ?? 0).getTime();
      return bKey - aKey;
    })
    .slice(0, 3);

  const showSurveysDashboard = surveysOpenCollecting.length > 0 || surveysRecentThree.length > 0;
  const isInstructor = role.role === "instructor";
  const dashboardSurveyTz = course?.time_zone ?? "America/New_York";

  const formatSurveyDueShort = (s: StaffSurveyDashRow) =>
    s.due_date ? formatInTimeZone(new TZDate(s.due_date), dashboardSurveyTz, "MMM d") : "—";

  const renderSurveyMiniTable = (rows: StaffSurveyDashRow[], { showClosedHint }: { showClosedHint: boolean }) => (
    <Table.Root
      size="sm"
      css={{
        "& td": { py: 2, px: 2 }
      }}
    >
      <Table.Body>
        {rows.map((s) => (
          <Table.Row key={s.id}>
            <Table.Cell>
              <HStack gap={2} align="flex-start" flexWrap="wrap" rowGap={1}>
                <Text fontSize="sm" fontWeight="medium" whiteSpace="normal" wordBreak="break-word">
                  {s.title ?? "Untitled"}
                </Text>
                {showClosedHint && s.status === "closed" && (
                  <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                    closed
                  </Text>
                )}
              </HStack>
            </Table.Cell>
            <Table.Cell whiteSpace="nowrap">
              <Text fontSize="sm" color="fg.muted">
                {formatSurveyDueShort(s)}
              </Text>
            </Table.Cell>
            <Table.Cell textAlign="end" whiteSpace="nowrap">
              <HStack gap={3} justify="flex-end">
                <Link href={`/course/${course_id}/manage/surveys/${s.survey_id}/responses`}>
                  <Text fontSize="sm" color="blue.600">
                    Results
                  </Text>
                </Link>
                {isInstructor && s.status === "published" && (
                  <Link href={`/course/${course_id}/manage/surveys/${s.id}/edit`}>
                    <Text fontSize="sm" color="blue.600">
                      Edit
                    </Text>
                  </Link>
                )}
              </HStack>
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );

  return (
    <VStack spaceY={0} align="stretch" p={2}>
      {!githubIdentity && <LinkAccount />}
      <ResendOrgInvitation />

      {showSurveysDashboard && (
        <Box mb={2} borderWidth="1px" borderColor="border.subtle" borderRadius="md" overflowX="auto">
          <HStack
            justify="space-between"
            align="center"
            px={2}
            py={1.5}
            borderBottomWidth="1px"
            borderColor="border.subtle"
          >
            <Heading size="md">Surveys</Heading>
            <Link href={`/course/${course_id}/manage/surveys`}>
              <Text fontSize="sm" color="blue.600">
                All
              </Text>
            </Link>
          </HStack>
          <Box px={1} py={1}>
            {surveysOpenCollecting.length > 0 && (
              <Box mb={surveysRecentThree.length > 0 ? 1 : 0}>
                <Text fontSize="sm" color="fg.muted" fontWeight="semibold" px={1} mb={1}>
                  Open
                </Text>
                {renderSurveyMiniTable(surveysOpenCollecting, { showClosedHint: false })}
              </Box>
            )}
            {surveysRecentThree.length > 0 && (
              <Box>
                <Text fontSize="sm" color="fg.muted" fontWeight="semibold" px={1} mb={1}>
                  Recent
                </Text>
                {renderSurveyMiniTable(surveysRecentThree, { showClosedHint: true })}
              </Box>
            )}
          </Box>
        </Box>
      )}

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
          &nbsp;“Grading due” reflects the due date for grading work.
        </Text>
        {metricsLoadFailed ? (
          <CardRoot borderColor="red.200" borderWidth="1px">
            <CardBody>
              <Text color="red.700" _dark={{ color: "red.200" }}>
                Unable to load assignment metrics right now. Please refresh in a moment.
              </Text>
            </CardBody>
          </CardRoot>
        ) : (
          <>
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
                  <Text fontWeight="semibold">Grade Release Status</Text>
                </CardHeader>
                <CardBody>
                  <Text fontSize="2xl" fontWeight="bold">
                    {fullyReleasedAssignments}/{releasableAssignments}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    {partiallyReleasedAssignments} partial, {unreleasedAssignments} not released,{" "}
                    {noSubmissionAssignments} no submissions
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
          </>
        )}
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
              <CardBody>
                Requested: <TimeZoneAwareDate date={request.created_at} format="compact" />
              </CardBody>
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
                <DashboardBadge tone={hourStats.errorCount > 0 ? "danger" : "success"}>
                  {hourStats.errorCount > 0 ? `${hourStats.errorCount} errors` : "No errors"}
                </DashboardBadge>
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
                <DashboardBadge tone={dayStats.errorCount > 0 ? "danger" : "success"}>
                  {dayStats.errorCount > 0 ? `${dayStats.errorCount} errors` : "No errors"}
                </DashboardBadge>
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
                    <DashboardBadge tone="warning">View All</DashboardBadge>
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

                      return (
                        <Box key={error.id} p={2} border="1px solid" borderColor="border.subtle" borderRadius="md">
                          <Flex justify="space-between" align="start" mb={1}>
                            <Text fontSize="sm" fontWeight="medium" color="red.600">
                              {error.name}
                            </Text>
                            <Text fontSize="xs" color="fg.muted">
                              <TimeZoneAwareDate date={error.created_at} format="compact" />
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
