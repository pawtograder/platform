import { CardHeader, CardRoot, CardBody, DataListRoot, DataListItem, DataListItemLabel, DataListItemValue } from "@chakra-ui/react";
import { Stack } from "@chakra-ui/react";
import { Box, Heading } from "@chakra-ui/react";
import { VStack } from "@chakra-ui/react";
import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";
import { createClient } from "@/utils/supabase/server";
import Link from "next/link";

export default async function CourseLanding({
  params,
}: {
  params: Promise<{ course_id: string }>
}) {
  const course_id = Number.parseInt((await params).course_id);
  const supabase = await createClient();

  const { data: assignments, error: assignmentsError } = await supabase
    .from("assignments")
    .select("*, submissions(*, grader_results(*))")
    .eq("class_id", course_id)
    .gte("due_date", new Date().toISOString())
    .order("due_date", { ascending: false })
    .limit(5);
  if (assignmentsError) {
    console.error(assignmentsError);
  }

  console.log(assignments);
  const { data: discussions } = await supabase
    .from("discussion_threads")
    .select("*, public_profiles(*), discussion_topics(*)")
    .eq("class", course_id)
    .is("root", null)
    .order("created_at", { ascending: false })
    .limit(5);

  const { data: helpRequests } = await supabase
    .from("help_requests")
    .select("*, public_profiles(*)")
    .eq("class", course_id)
    .eq("status", "open")
    .order("created_at", { ascending: true });

  return (
    <VStack spaceY={8} align="stretch" p={8}>
      <Heading size="xl">Course Dashboard</Heading>
      <Box>
        <Heading size="lg" mb={4}>Upcoming Assignments</Heading>
        <Stack spaceY={4}>
          {assignments?.map(assignment => {
            const mostRecentSubmission = assignment.submissions?.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0];
            return (<CardRoot key={assignment.id}>
              <CardHeader>
                <Link prefetch={true} href={`/course/${course_id}/assignment/${assignment.id}`}>
                  {assignment.title}
                </Link>
              </CardHeader>
              <CardBody>
                <DataListRoot>
                <DataListItem>
                  <DataListItemLabel>Due</DataListItemLabel>
                  <DataListItemValue>{assignment.due_date ? new Date(assignment.due_date).toLocaleDateString() : "No due date"}</DataListItemValue>
                </DataListItem>
                <DataListItem>
                  <DataListItemLabel>Most recent submission</DataListItemLabel>
                  <DataListItemValue>#{mostRecentSubmission.id}, score: {mostRecentSubmission.grader_results?.score}</DataListItemValue>
                </DataListItem>
                </DataListRoot>
              </CardBody>
            </CardRoot>)
          })}
        </Stack>
      </Box>

      <Box>
        <Heading size="lg" mb={4}>Recent Discussions</Heading>
        <Stack spaceY={4}>
          {discussions?.map(thread => (
            <Link prefetch={true} href={`/course/${course_id}/discussion/${thread.id}`} key={thread.id}>
              <DiscussionPostSummary thread={thread} />
            </Link>
          ))}
        </Stack>
      </Box>

      <Box>
        <Heading size="lg" mb={4}>Open Help Requests</Heading>
        <Stack spaceY={4}>
          {helpRequests?.map(request => (
            <CardRoot key={request.id}>
              <CardHeader>
                <Link href={`/course/${course_id}/help/${request.id}`}>
                  {request.request}
                </Link>
              </CardHeader>
              <CardBody>
                Requested: {new Date(request.created_at).toLocaleString()}
              </CardBody>
            </CardRoot>
          ))}
        </Stack>
      </Box>
    </VStack>
  );
  return <div>WIP</div>
}