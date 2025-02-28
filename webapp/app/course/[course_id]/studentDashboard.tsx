import { CardHeader, CardRoot, CardBody, DataListRoot, DataListItem, DataListItemLabel, DataListItemValue } from "@chakra-ui/react";
import { Stack } from "@chakra-ui/react";
import { Box, Heading } from "@chakra-ui/react";
import { VStack } from "@chakra-ui/react";
import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";
import { createClient } from "@/utils/supabase/server";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
export default async function StudentDashboard({ course_id }: { course_id: number }) {
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
    const { data: topics } = await supabase
        .from("discussion_topics")
        .select("*")
        .eq("class_id", course_id);

    const { data: discussions } = await supabase
        .from("discussion_threads")
        .select("*")
        .eq("root_class_id", course_id)
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
                        const mostRecentSubmission = assignment.submissions?.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
                        return (<CardRoot key={assignment.id}>
                            <CardHeader>
                                <Link prefetch={true} href={`/course/${course_id}/assignments/${assignment.id}`}>
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
                                        <DataListItemValue>{mostRecentSubmission ? `#${mostRecentSubmission.ordinal}, score: ${mostRecentSubmission.grader_results?.score}/${mostRecentSubmission.grader_results?.max_score}` : "No submissions"}</DataListItemValue>
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
                    {discussions?.map(thread => {
                        const topic = topics?.find(t => t.id === thread.topic_id);
                        if (!topic) {
                            return <Skeleton key={thread.id} height="100px" />
                        }
                        return <Link prefetch={true} href={`/course/${course_id}/discussion/${thread.id}`} key={thread.id}>
                            <DiscussionPostSummary thread={thread} topic={topic} />
                        </Link>
                    })}
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
}