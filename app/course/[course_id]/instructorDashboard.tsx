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
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { formatInTimeZone } from "date-fns-tz";
import Link from "next/link";
export default async function InstructorDashboard({ course_id }: { course_id: number }) {
  const supabase = await createClient();
  const { data: assignments, error: assignmentsError } = await supabase
    .from("assignments")
    .select("*,repositories(id), submissions(profile_id, grader_results(score,max_score)), classes(time_zone)")
    .eq("class_id", course_id)
    .gte("due_date", new Date().toISOString())
    .order("due_date", { ascending: false })
    .limit(5);
  if (assignmentsError) {
    console.error(assignmentsError);
  }
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

  await supabase.from("poll_questions").select("*, poll_question_answers(*)").eq("class_id", course_id);
  return (
    <VStack spaceY={8} align="stretch" p={8}>
      <Heading size="xl">Course Dashboard</Heading>
      {/* <Box>
                <Heading size="lg" mb={4}>Poll Questions</Heading>
                {pollQuestions?.map(question => (
                    <PollQuestionForm key={question.id} question={question} />
                ))}
            </Box> */}
      <Box>
        <Heading size="lg" mb={4}>
          Upcoming Assignments
        </Heading>
        <Stack spaceY={4}>
          {assignments?.map((assignment) => {
            return (
              <CardRoot key={assignment.id}>
                <CardHeader>
                  <Link prefetch={true} href={`/course/${course_id}/manage/assignments/${assignment.id}`}>
                    {assignment.title}
                  </Link>
                </CardHeader>
                <CardBody>
                  <DataListRoot orientation="horizontal">
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
              <Link prefetch={true} href={`/course/${course_id}/discussion/${thread.id}`} key={thread.id}>
                <DiscussionPostSummary thread={thread} topic={topic} />
              </Link>
            );
          })}
        </Stack>
      </Box>

      <Box>
        <Heading size="lg" mb={4}>
          Open Help Requests
        </Heading>
        <Stack spaceY={4}>
          {helpRequests?.map((request) => (
            <CardRoot key={request.id}>
              <CardHeader>
                <Link href={`/course/${course_id}/help/${request.id}`}>{request.request}</Link>
              </CardHeader>
              <CardBody>Requested: {new Date(request.created_at).toLocaleString()}</CardBody>
            </CardRoot>
          ))}
        </Stack>
      </Box>
    </VStack>
  );
}
