import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";
import { Skeleton } from "@/components/ui/skeleton";
import StudentLabSection from "@/components/ui/student-lab-section";
import { createClient } from "@/utils/supabase/server";
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
  VStack
} from "@chakra-ui/react";
import { formatInTimeZone } from "date-fns-tz";

import LinkAccount from "@/components/github/link-account";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";
import { TZDate } from "@date-fns/tz";
import Link from "next/link";
import RegradeRequestsTable from "./RegradeRequestsTable";
export default async function StudentDashboard({ course_id }: { course_id: number }) {
  const supabase = await createClient();
  const { data: assignments } = await supabase
    .from("assignments_with_effective_due_dates")
    .select("*, submissions!submissio_assignment_id_fkey(*, grader_results(*)), classes(time_zone)")
    .eq("class_id", course_id)
    .eq("submissions.is_active", true)
    .gte("due_date", new Date().toISOString())
    .order("due_date", { ascending: false })
    .limit(5);
  const { data: topics } = await supabase.from("discussion_topics").select("*").eq("class_id", course_id);

  const { data: discussions } = await supabase
    .from("discussion_threads")
    .select("*")
    .eq("root_class_id", course_id)
    .order("created_at", { ascending: false })
    .limit(5);

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

  return (
    <VStack spaceY={0} align="stretch" p={2}>
      {identities.data && !githubIdentity && <LinkAccount />}
      <ResendOrgInvitation />
      <Heading size="xl">Course Dashboard</Heading>

      <StudentLabSection />
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
                        {assignment.due_date
                          ? formatInTimeZone(
                              new TZDate(assignment.due_date),
                              assignment.classes?.time_zone || "America/New_York",
                              "Pp"
                            )
                          : "No due date"}
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

      <Box>
        <Heading size="lg" mb={4}>
          Recent Discussions
        </Heading>
        <Stack spaceY={4}>
          {discussions?.map((thread) => {
            const topic = topics?.find((t) => t.id === thread.topic_id);
            if (!topic) {
              return <Skeleton key={thread.id} height="100px" />;
            }
            return (
              <Link href={`/course/${course_id}/discussion/${thread.id}`} key={thread.id}>
                <DiscussionPostSummary thread={thread} topic={topic} />
              </Link>
            );
          })}
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
              <CardBody>Requested: {new Date(request.created_at).toLocaleString()}</CardBody>
            </CardRoot>
          ))}
        </Stack>
      </Box>
    </VStack>
  );
}
