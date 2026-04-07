import { fetchStudentDashboardBundle } from "@/lib/ssr-course-dashboard";
import { findGithubIdentity } from "@/lib/githubIdentity";
import { Survey, SurveyResponse } from "@/types/survey";
import type { RegradeRequestWithDetails } from "@/utils/supabase/DatabaseTypes";
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
  Heading,
  HStack,
  Icon,
  Stack,
  Text,
  VStack
} from "@chakra-ui/react";
import { format, formatDistanceToNow, isPast } from "date-fns";
import { FaClipboardList, FaExclamationCircle } from "react-icons/fa";

import CalendarScheduleSummary from "@/components/calendar/calendar-schedule-summary";
import { DiscussionSummary } from "@/components/discussion/DiscussionSummary";
import LinkAccount from "@/components/github/link-account";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";
import { OfficeHoursStatusCard } from "@/components/help-queue/office-hours-status-card";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { createClient } from "@/utils/supabase/server";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import RegradeRequestsTable from "./RegradeRequestsTable";

function SurveyDashboardCta({
  href,
  label,
  ariaLabel,
  colorPalette
}: {
  href: string;
  label: string;
  ariaLabel: string;
  colorPalette: "blue" | "red" | "yellow" | "green" | "gray";
}) {
  return (
    <Link href={href} aria-label={ariaLabel} style={{ textDecoration: "none" }}>
      <Box
        as="span"
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
        h="8"
        px="3"
        fontSize="sm"
        fontWeight="medium"
        borderRadius="l2"
        colorPalette={colorPalette}
        bg="colorPalette.solid"
        color="colorPalette.contrast"
        _hover={{ opacity: 0.92 }}
        _active={{ opacity: 0.88 }}
      >
        {label}
      </Box>
    </Link>
  );
}

function sortIncompleteSurveysForBanner(surveys: Survey[]): Survey[] {
  const now = Date.now();
  return [...surveys].sort((a, b) => {
    const aTime = a.due_date ? new Date(a.due_date).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.due_date ? new Date(b.due_date).getTime() : Number.POSITIVE_INFINITY;
    const aOver = a.due_date != null && aTime < now;
    const bOver = b.due_date != null && bTime < now;
    if (aOver !== bOver) {
      return aOver ? -1 : 1;
    }
    return aTime - bTime;
  });
}

export default async function StudentDashboard({
  course_id,
  private_profile_id
}: {
  course_id: number;
  private_profile_id: string;
}) {
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");

  const supabase = await createClient();
  const { course, assignments, surveysRaw, regradeRequests, responsesRaw, classSection, labSection, leadersRaw } =
    await fetchStudentDashboardBundle(supabase, course_id, user_id ?? "", private_profile_id);

  const identitiesResult = await supabase.auth.getUserIdentities();
  const githubIdentity = findGithubIdentity(identitiesResult.data?.identities);

  const hasCalendar = Boolean(course?.office_hours_ics_url || course?.events_ics_url);

  const nowMs = Date.now();
  const surveys = ((surveysRaw ?? []) as unknown as Survey[]).filter(
    (s) => s.status === "published" && (s.available_at == null || new Date(s.available_at).getTime() <= nowMs)
  );

  const surveyResponses = (responsesRaw ?? []) as unknown as SurveyResponse[];

  type StudentUpcomingAssignmentRow = {
    id: number;
    title: string | null;
    due_date: string | null;
    submissions?: Array<{
      created_at: string;
      ordinal: number | null;
      grader_results?: { errors?: unknown; score?: number | null; max_score?: number | null } | null;
    }> | null;
  };
  const upcomingAssignments = (assignments ?? []) as StudentUpcomingAssignmentRow[];
  const regradeRows = (regradeRequests ?? []) as RegradeRequestWithDetails[];

  // Build a quick lookup: survey_id -> response
  const responsesBySurveyId = new Map<string, SurveyResponse>();
  for (const r of surveyResponses) {
    responsesBySurveyId.set(r.survey_id, r);
  }

  const incompletePublishedSurveys = surveys.filter((s) => {
    const r = responsesBySurveyId.get(s.id);
    return !r?.is_submitted;
  });
  const incompleteSurveysForBanner = sortIncompleteSurveysForBanner(incompletePublishedSurveys);

  const labLeaders: string[] =
    leadersRaw
      ?.map((l) => (l.profiles as { name: string | null })?.name)
      .filter((name): name is string => name !== null) ?? [];

  const DAYS_OF_WEEK: Record<string, string> = {
    monday: "Monday",
    tuesday: "Tuesday",
    wednesday: "Wednesday",
    thursday: "Thursday",
    friday: "Friday",
    saturday: "Saturday",
    sunday: "Sunday"
  };

  const formatTime = (time: string) => {
    return format(new Date(`2000-01-01T${time}`), "h:mm a");
  };

  const getDayDisplayName = (day: string) => {
    return DAYS_OF_WEEK[day] || day;
  };

  return (
    <VStack spaceY={0} align="stretch" p={2}>
      {identitiesResult.data && !githubIdentity && <LinkAccount />}
      <ResendOrgInvitation />

      {incompleteSurveysForBanner.length > 0 && (
        <Box w="100%" mb={3}>
          <Text fontWeight="semibold" fontSize="sm" mb={2} color="fg.muted">
            Surveys to complete
          </Text>
          <VStack gap={2} align="stretch">
            {incompleteSurveysForBanner.map((survey) => {
              const response = responsesBySurveyId.get(survey.id);
              const isOverdue = Boolean(survey.due_date && isPast(new Date(survey.due_date)));
              const inProgress = Boolean(response && !response.is_submitted);
              const href = `/course/${course_id}/surveys/${survey.id}`;
              return (
                <Box
                  key={survey.id}
                  w="100%"
                  p={3}
                  borderRadius="md"
                  border="1px solid"
                  borderColor={isOverdue ? "red.300" : "blue.300"}
                  bg={isOverdue ? "red.50" : "blue.50"}
                  _dark={{
                    bg: isOverdue ? "red.900" : "blue.900",
                    borderColor: isOverdue ? "red.600" : "blue.600"
                  }}
                >
                  <HStack justify="space-between" align="center" flexWrap="wrap" gap={3}>
                    <HStack gap={3} align="flex-start">
                      <Icon fontSize="lg" color={isOverdue ? "red.500" : "blue.500"} mt={0.5}>
                        {isOverdue ? <FaExclamationCircle /> : <FaClipboardList />}
                      </Icon>
                      <VStack align="start" gap={0}>
                        <HStack gap={2} flexWrap="wrap">
                          <Text fontWeight="semibold" fontSize="sm">
                            {survey.title ?? "Untitled survey"}
                          </Text>
                          <Badge colorPalette={isOverdue ? "red" : inProgress ? "yellow" : "blue"} size="sm">
                            {isOverdue ? "Overdue" : inProgress ? "In progress" : "Pending"}
                          </Badge>
                        </HStack>
                        {survey.due_date && (
                          <Text fontSize="xs" color="fg.muted">
                            {isOverdue
                              ? `Was due ${formatDistanceToNow(new Date(survey.due_date), { addSuffix: true })}`
                              : `Due ${formatDistanceToNow(new Date(survey.due_date), { addSuffix: true })}`}
                          </Text>
                        )}
                      </VStack>
                    </HStack>
                    <SurveyDashboardCta
                      href={href}
                      label={inProgress ? "Continue" : "Take survey"}
                      ariaLabel={`${inProgress ? "Continue" : "Take survey"}: ${survey.title ?? "Untitled survey"}`}
                      colorPalette={isOverdue ? "red" : "blue"}
                    />
                  </HStack>
                </Box>
              );
            })}
          </VStack>
        </Box>
      )}

      {/* Section Cards */}
      {(classSection || labSection) && (
        <HStack gap={4} align="stretch" flexWrap="wrap">
          {/* Course Section Card */}
          {classSection && (
            <CardRoot flex={1} minW="200px" h="100%">
              <CardBody p={3} h="100%" display="flex" flexDirection="column">
                <Text fontSize="xs" color="fg.muted" mb={2} fontWeight="medium">
                  Course Section
                </Text>
                <VStack align="start" gap={1} flex={1}>
                  <Text fontWeight="medium" fontSize="sm">
                    {classSection.name}
                  </Text>
                  {classSection.meeting_times && (
                    <Text fontSize="xs" color="fg.muted">
                      {classSection.meeting_times}
                    </Text>
                  )}
                  {classSection.meeting_location && (
                    <Text fontSize="xs" color="fg.muted">
                      📍 {classSection.meeting_location}
                    </Text>
                  )}
                </VStack>
              </CardBody>
            </CardRoot>
          )}

          {/* Lab Section Card */}
          {labSection && (
            <CardRoot flex={1} minW="200px" h="100%">
              <CardBody p={3} h="100%" display="flex" flexDirection="column">
                <Text fontSize="xs" color="fg.muted" mb={2} fontWeight="medium">
                  Lab Section
                </Text>
                <VStack align="start" gap={1} flex={1}>
                  <Text fontWeight="medium" fontSize="sm">
                    {labSection.name}
                  </Text>
                  {labSection.day_of_week && (
                    <Text fontSize="xs" color="fg.muted">
                      {getDayDisplayName(labSection.day_of_week)}
                      {labSection.start_time && ` • ${formatTime(labSection.start_time)}`}
                      {labSection.end_time && ` - ${formatTime(labSection.end_time)}`}
                    </Text>
                  )}
                  {labSection.meeting_location && (
                    <Text fontSize="xs" color="fg.muted">
                      📍 {labSection.meeting_location}
                    </Text>
                  )}
                  {labLeaders.length > 0 && (
                    <Text fontSize="xs" color="fg.muted">
                      👤 {labLeaders.join(", ")}
                    </Text>
                  )}
                </VStack>
              </CardBody>
            </CardRoot>
          )}
        </HStack>
      )}

      {/* Calendar Schedule Section */}
      {hasCalendar && <CalendarScheduleSummary />}
      <Box>
        <Heading size="lg" mb={4}>
          Upcoming Assignments
        </Heading>
        <Stack spaceY={4}>
          {upcomingAssignments.map((assignment) => {
            const mostRecentSubmission = assignment.submissions?.sort(
              (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            )[0];

            let mostRecentSubmissionScoreAdvice = "In Progress";
            if (mostRecentSubmission) {
              if (mostRecentSubmission.grader_results) {
                if (mostRecentSubmission.grader_results.errors) {
                  mostRecentSubmissionScoreAdvice = "Error";
                } else {
                  mostRecentSubmissionScoreAdvice = `${mostRecentSubmission.grader_results?.score}/${mostRecentSubmission.grader_results?.max_score}`;
                }
              }
            }
            return (
              <CardRoot key={assignment.id}>
                <CardHeader>
                  <Link href={`/course/${course_id}/assignments/${assignment.id}`}>{assignment.title}</Link>
                </CardHeader>
                <CardBody>
                  <DataListRoot>
                    <DataListItem>
                      <DataListItemLabel>Due</DataListItemLabel>
                      <DataListItemValue>
                        {assignment.due_date ? (
                          <TimeZoneAwareDate date={assignment.due_date} format="Pp" />
                        ) : (
                          "No due date"
                        )}
                      </DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Most recent submission</DataListItemLabel>
                      <DataListItemValue>
                        {mostRecentSubmission
                          ? `#${mostRecentSubmission.ordinal}, ${mostRecentSubmissionScoreAdvice}`
                          : "No submissions"}
                      </DataListItemValue>
                    </DataListItem>
                  </DataListRoot>
                </CardBody>
              </CardRoot>
            );
          })}
        </Stack>
      </Box>

      {/* Discussion Activity Summary */}
      {user_id && <DiscussionSummary courseId={course_id} userId={user_id} />}

      <Box>
        <Heading size="lg" mb={4}>
          Active Surveys
        </Heading>
        <Stack spaceY={4}>
          {!surveys || surveys.length === 0 ? (
            <CardRoot>
              <CardHeader>No active surveys</CardHeader>
              <CardBody>
                <DataListRoot>
                  <DataListItem>
                    <DataListItemLabel>Info</DataListItemLabel>
                    <DataListItemValue>
                      There are no published surveys for you in this course right now.
                    </DataListItemValue>
                  </DataListItem>
                </DataListRoot>
              </CardBody>
            </CardRoot>
          ) : (
            surveys.map((survey) => {
              const response = responsesBySurveyId.get(survey.id);

              let statusLabel = "Not started";
              let buttonLabel = "Start";
              let colorScheme: "blue" | "yellow" | "green" | "gray" = "blue";

              if (response) {
                if (response.is_submitted) {
                  if (survey.allow_response_editing) {
                    statusLabel = "Submitted (editable)";
                    buttonLabel = "Edit";
                    colorScheme = "green";
                  } else {
                    statusLabel = "Submitted (locked)";
                    buttonLabel = "View";
                    colorScheme = "gray";
                  }
                } else {
                  statusLabel = "In progress";
                  buttonLabel = "Continue";
                  colorScheme = "yellow";
                }
              }

              const href = `/course/${course_id}/surveys/${survey.id}`;

              return (
                <CardRoot key={survey.id}>
                  <CardHeader>
                    <Stack direction="row" justify="space-between" align="center" gap={4}>
                      <Box>
                        <Link href={href}>
                          <Text as="span" fontWeight="semibold">
                            {survey.title ?? "Untitled survey"}
                          </Text>
                        </Link>
                        {survey.description && (
                          <Text fontSize="sm" opacity={0.8} mt={1}>
                            {survey.description}
                          </Text>
                        )}
                        <Text fontSize="xs" opacity={0.6} mt={1}>
                          {statusLabel}
                        </Text>
                      </Box>
                      <SurveyDashboardCta
                        href={href}
                        label={buttonLabel}
                        ariaLabel={`${buttonLabel} survey: ${survey.title ?? "Untitled survey"}`}
                        colorPalette={colorScheme}
                      />
                    </Stack>
                  </CardHeader>
                  <CardBody>
                    <DataListRoot>
                      <DataListItem>
                        <DataListItemLabel>Due</DataListItemLabel>
                        <DataListItemValue>
                          {survey.due_date ? <TimeZoneAwareDate date={survey.due_date} format="Pp" /> : "No due date"}
                        </DataListItemValue>
                      </DataListItem>

                      {response?.submitted_at && (
                        <DataListItem>
                          <DataListItemLabel>Submitted</DataListItemLabel>
                          <DataListItemValue>
                            <TimeZoneAwareDate date={response.submitted_at} format="Pp" />
                          </DataListItemValue>
                        </DataListItem>
                      )}
                    </DataListRoot>
                  </CardBody>
                </CardRoot>
              );
            })
          )}
        </Stack>
      </Box>

      <Box>
        <Heading size="lg" mb={4}>
          Recent Regrade Requests
        </Heading>
        <RegradeRequestsTable regradeRequests={regradeRows} courseId={course_id} />
        {regradeRows.length > 0 && (
          <Link href={`/course/${course_id}/regrade-requests`}>
            <Box mt={4} textAlign="center">
              <span style={{ color: "var(--chakra-colors-blue-500)", textDecoration: "underline" }}>
                View all regrade requests →
              </span>
            </Box>
          </Link>
        )}
      </Box>

      {/* Only show OfficeHoursStatusCard when no calendar is configured - serves as fallback */}
      {!hasCalendar && (
        <Box>
          <Suspense
            fallback={
              <Box>
                <Heading size="lg" mb={4}>
                  Office Hours
                </Heading>
                <CardRoot>
                  <CardBody>
                    <Text color="fg.muted">Loading office hours...</Text>
                  </CardBody>
                </CardRoot>
              </Box>
            }
          >
            <OfficeHoursStatusCard />
          </Suspense>
        </Box>
      )}
    </VStack>
  );
}
