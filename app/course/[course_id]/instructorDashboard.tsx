import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";
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
  Skeleton,
  Stack,
  VStack,
  Badge,
  Flex,
  Text
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { formatInTimeZone } from "date-fns-tz";
import Link from "next/link";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { Database } from "@/utils/supabase/SupabaseTypes";
import ResendOrgInvitation from "@/components/github/resend-org-invitation";
import { getPrivateProfileId } from "@/lib/ssrUtils";

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

type RecentAssignment = GetResult<
  Database["public"],
  Database["public"]["Tables"]["assignments"]["Row"],
  "assignments",
  Database["public"]["Tables"]["assignments"]["Relationships"],
  "*, repositories(id, profile_id, assignment_group_id), submissions(id, profile_id, assignment_group_id, is_active, submission_reviews!submissions_grading_review_id_fkey(id, completed_at, total_score, completed_by, grader)), submission_regrade_requests(id, status), assignment_due_date_exceptions(id, student_id, assignment_group_id, hours, minutes), classes(time_zone)"
>;
export default async function InstructorDashboard({ course_id }: { course_id: number }) {
  const supabase = await createClient();

  // Get current user's private profile ID for review assignments
  const private_profile_id = await getPrivateProfileId(course_id);

  // Get recently due assignments (due in last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: recentAssignments, error: assignmentsError } = await supabase
    .from("assignments")
    .select(
      `
      *,
      repositories(id, profile_id, assignment_group_id),
      submissions(id, profile_id, assignment_group_id, is_active, submission_reviews!submissions_grading_review_id_fkey(id, completed_at, total_score, completed_by, grader)),
      submission_regrade_requests(id, status),
      assignment_due_date_exceptions(id, student_id, assignment_group_id, hours, minutes),
      classes(time_zone)
    `
    )
    .eq("class_id", course_id)
    .lte("due_date", new Date().toISOString())
    .gte("due_date", thirtyDaysAgo.toISOString())
    .order("due_date", { ascending: false })
    .limit(10);

  if (assignmentsError) {
    console.error(assignmentsError);
  }

  // Get upcoming assignments for comparison
  const { data: upcomingAssignments } = await supabase
    .from("assignments")
    .select("*,repositories(id), submissions(profile_id, grader_results(score,max_score)), classes(time_zone)")
    .eq("class_id", course_id)
    .gte("due_date", new Date().toISOString())
    .order("due_date", { ascending: true })
    .limit(5);

  const { data: topics } = await supabase.from("discussion_topics").select("*").eq("class_id", course_id);

  const { data: discussions } = await supabase
    .from("discussion_threads")
    .select("*, profiles(*), discussion_topics(*)")
    .eq("root_class_id", course_id)
    .order("created_at", { ascending: false })
    .limit(5);

  const { data: helpRequests } = await supabase
    .from("help_requests")
    .select("*, profiles(*)")
    .eq("class_id", course_id)
    .eq("status", "open")
    .order("created_at", { ascending: true });

  // Get review assignments for current user
  const { data: allReviewAssignmentsSummary } = private_profile_id
    ? await supabase
        .from("review_assignments_summary_by_assignee")
        .select("*")
        .eq("class_id", course_id)
        .eq("assignee_profile_id", private_profile_id)
        .order("soonest_due_date", { ascending: true })
    : { data: null };

  //Show all review assignments that are not completed, and then up to 2 most recent fully completed
  const reviewAssignmentsSummary = allReviewAssignmentsSummary
    ?.filter((summary) => (summary.incomplete_reviews ?? 0) > 0)
    .concat(allReviewAssignmentsSummary?.filter((summary) => (summary.incomplete_reviews ?? 0) === 0).slice(0, 2));

  const calculateAssignmentStatistics = (assignment: RecentAssignment) => {
    // Calculate unique submitters (students or groups who have submitted)
    const uniqueSubmitters = new Set();
    assignment.submissions?.forEach((submission) => {
      if (submission.is_active) {
        if (submission.profile_id) {
          uniqueSubmitters.add(submission.profile_id);
        } else if (submission.assignment_group_id) {
          uniqueSubmitters.add(`group_${submission.assignment_group_id}`);
        }
      }
    });

    // Calculate graded submissions
    const gradedSubmissions =
      assignment.submissions?.filter(
        (submission) =>
          submission.submission_reviews?.completed_at !== null && submission.submission_reviews?.completed_by !== null
      ).length || 0;

    // Calculate regrade requests
    const openRegradeRequests =
      assignment.submission_regrade_requests?.filter((request) => request.status === "opened").length || 0;

    const closedRegradeRequests =
      assignment.submission_regrade_requests?.filter(
        (request) => request.status === "closed" || request.status === "resolved"
      ).length || 0;

    // Calculate students who can still submit (have extensions that extend past now)
    const now = new Date();
    const dueDate = new Date(assignment.due_date);
    let studentsWithValidExtensions = 0;

    assignment.assignment_due_date_exceptions?.forEach((exception) => {
      const extensionHours = exception.hours;
      const extensionMinutes = exception.minutes;
      const extendedDueDate = new Date(dueDate.getTime() + (extensionHours * 60 + extensionMinutes) * 60 * 1000);

      if (extendedDueDate > now) {
        studentsWithValidExtensions++;
      }
    });

    // Calculate total repositories (students who accepted assignment)
    const totalRepositories = assignment.repositories?.length || 0;

    return {
      totalSubmissions: uniqueSubmitters.size,
      gradedSubmissions,
      totalRepositories,
      openRegradeRequests,
      closedRegradeRequests,
      studentsWithValidExtensions
    };
  };
  const { data: course } = await supabase.from("classes").select("time_zone").eq("id", course_id).single();

  return (
    <VStack spaceY={0} align="stretch" p={2}>
      <Heading size="xl">Course Dashboard</Heading>
      <ResendOrgInvitation />

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
                    <Link
                      prefetch={true}
                      href={`/course/${course_id}/manage/assignments/${reviewSummary.assignment_id}`}
                    >
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
          {recentAssignments?.map((assignment: RecentAssignment) => {
            const stats = calculateAssignmentStatistics(assignment);
            return (
              <CompactCardRoot key={assignment.id}>
                <CardHeader>
                  <Flex justify="space-between" align="center">
                    <Link prefetch={true} href={`/course/${course_id}/manage/assignments/${assignment.id}`}>
                      <Text fontWeight="semibold">{assignment.title}</Text>
                    </Link>
                    <Badge colorScheme="gray" size="sm">
                      Due{" "}
                      {formatInTimeZone(
                        new TZDate(assignment.due_date),
                        assignment.classes.time_zone || "America/New_York",
                        "MMM d"
                      )}
                    </Badge>
                  </Flex>
                </CardHeader>
                <CardBody>
                  <CompactDataListRoot orientation="horizontal">
                    <DataListItem>
                      <DataListItemLabel>Students accepted</DataListItemLabel>
                      <DataListItemValue>{stats.totalRepositories}</DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Submissions</DataListItemLabel>
                      <DataListItemValue>{stats.totalSubmissions}</DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Graded/Total</DataListItemLabel>
                      <DataListItemValue>
                        <Flex align="center" gap={2}>
                          <Text>
                            {stats.gradedSubmissions}/{stats.totalSubmissions}
                          </Text>
                          {stats.gradedSubmissions === stats.totalSubmissions && stats.totalSubmissions > 0 ? (
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
                      <DataListItemLabel>Can still submit</DataListItemLabel>
                      <DataListItemValue>
                        {stats.studentsWithValidExtensions > 0 ? (
                          <Badge colorScheme="blue" size="sm">
                            {stats.studentsWithValidExtensions}
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
                          {stats.openRegradeRequests > 0 && (
                            <Badge colorScheme="red" size="sm">
                              {stats.openRegradeRequests} open
                            </Badge>
                          )}
                          {stats.closedRegradeRequests > 0 && (
                            <Badge colorScheme="green" size="sm">
                              {stats.closedRegradeRequests} resolved
                            </Badge>
                          )}
                          {stats.openRegradeRequests === 0 && stats.closedRegradeRequests === 0 && <Text>None</Text>}
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
          {upcomingAssignments?.map((assignment) => {
            return (
              <CompactCardRoot key={assignment.id}>
                <CardHeader>
                  <Link prefetch={true} href={`/course/${course_id}/manage/assignments/${assignment.id}`}>
                    {assignment.title}
                  </Link>
                </CardHeader>
                <CardBody>
                  <CompactDataListRoot orientation="horizontal">
                    <DataListItem>
                      <DataListItemLabel>Due</DataListItemLabel>
                      <DataListItemValue>
                        {assignment.due_date
                          ? formatInTimeZone(
                              new TZDate(assignment.due_date),
                              assignment.classes.time_zone || "America/New_York",
                              "Pp"
                            )
                          : "No due date"}
                      </DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Students who have accepted the assignment</DataListItemLabel>
                      <DataListItemValue>{assignment.repositories.length}</DataListItemValue>
                    </DataListItem>
                    <DataListItem>
                      <DataListItemLabel>Students who have submitted</DataListItemLabel>
                      <DataListItemValue>
                        {new Set(assignment.submissions.map((s) => s.profile_id)).size}
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
          Recent Discussions
        </Heading>
        <Stack spaceY={4}>
          {discussions?.map((thread) => {
            const topic = topics?.find((t) => t.id === thread.topic_id);
            if (!topic) {
              return <Skeleton key={thread.id} height="100px" />;
            }
            return (
              <Link prefetch={true} href={`/course/${course_id}/discussion/${thread.id}`} key={thread.id}>
                <DiscussionPostSummary thread={thread} topic={topic} />
              </Link>
            );
          })}
        </Stack>
      </Box>

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
    </VStack>
  );
}
