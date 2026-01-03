import { Survey, SurveyResponse } from "@/types/survey";
import { createClient } from "@/utils/supabase/server";
import {
  Accordion,
  Box,
  Button,
  CardBody,
  CardHeader,
  CardRoot,
  DataListItem,
  DataListItemLabel,
  DataListItemValue,
  DataListRoot,
  Heading,
  HStack,
  Stack,
  Text,
  VStack
} from "@chakra-ui/react";
import { format } from "date-fns";

import { CalendarAccordionTrigger } from "@/components/calendar/calendar-accordion-trigger";
import CalendarScheduleSummary from "@/components/calendar/calendar-schedule-summary";
import { DiscussionSummary } from "@/components/discussion/DiscussionSummary";
import LinkAccount from "@/components/github/link-account";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { headers } from "next/headers";
import Link from "next/link";
import RegradeRequestsTable from "./RegradeRequestsTable";

export default async function StudentDashboard({
  course_id,
  private_profile_id
}: {
  course_id: number;
  private_profile_id: string;
}) {
  const supabase = await createClient();
  const { data: assignments } = await supabase
    .from("assignments_with_effective_due_dates")
    .select("*, submissions!submissio_assignment_id_fkey(*, grader_results(*)), classes(time_zone)")
    .eq("class_id", course_id)
    .eq("submissions.is_active", true)
    .eq("student_profile_id", private_profile_id)
    .gte("due_date", new Date().toISOString())
    .order("due_date", { ascending: false })
    .limit(5);

  const { data: surveysRaw } = await supabase
    .from("surveys")
    .select("*")
    .eq("class_id", course_id)
    .eq("status", "published")
    .or(`due_date.gte.${new Date().toISOString()},due_date.is.null`)
    .order("created_at", { ascending: false })
    .limit(5);

  const surveys = (surveysRaw ?? []) as unknown as Survey[];

  let surveyResponses: SurveyResponse[] = [];
  if (surveys.length > 0) {
    const surveyIds = surveys.map((s) => s.id);

    const { data: responsesRaw } = await supabase
      .from("survey_responses")
      .select("*")
      .eq("profile_id", private_profile_id)
      .in("survey_id", surveyIds);

    surveyResponses = (responsesRaw ?? []) as unknown as SurveyResponse[];
  }

  // Build a quick lookup: survey_id -> response
  const responsesBySurveyId = new Map<string, SurveyResponse>();
  for (const r of surveyResponses) {
    responsesBySurveyId.set(r.survey_id, r);
  }

  const { data: helpRequests } = await supabase
    .from("help_requests")
    .select("*")
    .eq("class_id", course_id)
    .eq("status", "open")
    .order("created_at", { ascending: true });

  // Query 5 most recent regrade requests for the student
  const { data: regradeRequests } = await supabase
    .from("submission_regrade_requests")
    .select(
      `
      *,
      assignments(id, title),
      submissions!inner(id, ordinal),
      submission_file_comments!submission_file_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_file_comments_rubric_check_id_fkey(name)),
      submission_artifact_comments!submission_artifact_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_artifact_comments_rubric_check_id_fkey(name)),
      submission_comments!submission_comments_regrade_request_id_fkey(rubric_check_id, rubric_checks!submission_comments_rubric_check_id_fkey(name))
    `
    )
    .eq("class_id", course_id)
    .order("created_at", { ascending: false })
    .limit(5);

  const identities = await supabase.auth.getUserIdentities();
  const githubIdentity = identities.data?.identities.find((identity) => identity.provider === "github");

  const { data: course } = await supabase
    .from("classes")
    .select("time_zone, office_hours_ics_url, events_ics_url")
    .eq("id", course_id)
    .single();

  const hasCalendar = course?.office_hours_ics_url || course?.events_ics_url;

  // Get user role to fetch section information
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");
  const { data: userRole } = user_id
    ? await supabase
        .from("user_roles")
        .select("class_section_id, lab_section_id")
        .eq("class_id", course_id)
        .eq("user_id", user_id)
        .eq("disabled", false)
        .single()
    : { data: null };

  // Fetch class section if assigned
  const { data: classSection } = userRole?.class_section_id
    ? await supabase.from("class_sections").select("*").eq("id", userRole.class_section_id).single()
    : { data: null };

  // Fetch lab section if assigned
  const { data: labSection } = userRole?.lab_section_id
    ? await supabase.from("lab_sections").select("*").eq("id", userRole.lab_section_id).single()
    : { data: null };

  // Fetch lab section leaders if lab section exists
  let labLeaders: string[] = [];
  if (labSection?.id) {
    const { data: leaders } = await supabase
      .from("lab_section_leaders")
      .select("profiles(name)")
      .eq("lab_section_id", labSection.id);
    if (leaders) {
      labLeaders = leaders
        .map((l) => (l.profiles as { name: string | null })?.name)
        .filter((name): name is string => name !== null);
    }
  }

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
      {identities.data && !githubIdentity && <LinkAccount />}
      <ResendOrgInvitation />
      <Heading size="xl">Course Dashboard</Heading>

      {/* Compact Section Info */}
      {(classSection || labSection) && (
        <CardRoot>
          <CardBody>
            <HStack gap={4} align="flex-start" flexWrap="wrap">
              {/* Course Section */}
              {classSection && (
                <Box flex={1} minW="200px">
                  <Text fontSize="xs" color="fg.muted" mb={1} fontWeight="medium">
                    Your Course Section
                  </Text>
                  <Text fontWeight="semibold" fontSize="sm" mb={1}>
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
                </Box>
              )}

              {/* Lab Section */}
              {labSection && (
                <Box flex={1} minW="200px">
                  <Text fontSize="xs" color="fg.muted" mb={1} fontWeight="medium">
                    Your Lab Section
                  </Text>
                  <Text fontWeight="semibold" fontSize="sm" mb={1}>
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
                </Box>
              )}
            </HStack>
          </CardBody>
        </CardRoot>
      )}

      {/* Calendar Schedule Section */}
      {hasCalendar && (
        <Accordion.Root collapsible defaultValue={[]}>
          <Accordion.Item value="schedule">
            <CalendarAccordionTrigger />
            <Accordion.ItemContent>
              <Accordion.ItemBody>
                <CalendarScheduleSummary />
              </Accordion.ItemBody>
            </Accordion.ItemContent>
          </Accordion.Item>
        </Accordion.Root>
      )}
      <Box>
        <Heading size="lg" mb={4}>
          Upcoming Assignments
        </Heading>
        <Stack spaceY={4}>
          {assignments?.map((assignment) => {
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
                      There are no published, active surveys for this course right now.
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
                      <Link href={href}>
                        <Button size="sm" colorScheme={colorScheme}>
                          {buttonLabel}
                        </Button>
                      </Link>
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
        <RegradeRequestsTable regradeRequests={regradeRequests || []} courseId={course_id} />
        {regradeRequests && regradeRequests.length > 0 && (
          <Link href={`/course/${course_id}/regrade-requests`}>
            <Box mt={4} textAlign="center">
              <span style={{ color: "var(--chakra-colors-blue-500)", textDecoration: "underline" }}>
                View all regrade requests →
              </span>
            </Box>
          </Link>
        )}
      </Box>

      <Box>
        <Heading size="lg" mb={4}>
          Open Office Hours
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
    </VStack>
  );
}
