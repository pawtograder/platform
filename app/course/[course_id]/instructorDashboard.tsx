import { CardHeader, CardRoot, CardBody, DataListRoot, DataListItem, DataListItemLabel, DataListItemValue, Skeleton } from "@chakra-ui/react";
import { Stack } from "@chakra-ui/react";
import { Box, Heading } from "@chakra-ui/react";
import { VStack } from "@chakra-ui/react";
import { DiscussionPostSummary } from "@/components/ui/discussion-post-summary";
import { createClient } from "@/utils/supabase/server";
import Link from "next/link";
import { PollQuestionForm } from "@/components/ui/polls/poll-question-form";
export default async function InstructorDashboard({ course_id }: { course_id: number }) {
    const supabase = await createClient();
    const { data: assignments, error: assignmentsError } = await supabase
        .from("assignments")
        .select("*,repositories(id), submissions(profile_id, grader_results(score,max_score))")
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

    const { data: pollQuestions, error: pollQuestionsError } = await supabase
        .from("poll_questions")
        .select("*, poll_question_answers(*)")
        .eq("class_id", course_id);
    if (pollQuestionsError) {
        console.error(pollQuestionsError);
    }
    return (
        <VStack spaceY={8} align="stretch" p={8}>
            <Heading size="xl">Course Dashboard</Heading>
            <Box>
                <Heading size="lg" mb={4}>Poll Questions</Heading>
                {pollQuestions?.map(question => (
                    <PollQuestionForm key={question.id} question={question} />
                ))}
            </Box>
            <Box>
                <Heading size="lg" mb={4}>Upcoming Assignments</Heading>
                <Stack spaceY={4}>
                    {assignments?.map(assignment => {
                        return (
                            <CardRoot key={assignment.id}>
                                <CardHeader>
                                    <Link
                                        prefetch={true}
                                        href={`/course/${course_id}/assignments/${assignment.id}`}
                                        legacyBehavior>
                                        {assignment.title}
                                    </Link>
                                </CardHeader>
                                <CardBody>
                                    <DataListRoot orientation="horizontal">
                                        <DataListItem>
                                            <DataListItemLabel>Due</DataListItemLabel>
                                            <DataListItemValue>{assignment.due_date ? new Date(assignment.due_date).toLocaleDateString() : "No due date"}</DataListItemValue>
                                        </DataListItem>
                                        <DataListItem>
                                            <DataListItemLabel>Students who have accepted the assignment</DataListItemLabel>
                                            <DataListItemValue>{assignment.repositories.length}</DataListItemValue>
                                        </DataListItem>
                                        <DataListItem>
                                            <DataListItemLabel>Students who have submitted</DataListItemLabel>
                                            <DataListItemValue>{new Set(assignment.submissions.map(s => s.profile_id)).size}</DataListItemValue>
                                        </DataListItem>
                                    </DataListRoot>
                                </CardBody>
                            </CardRoot>
                        );
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
                        return (
                            <Link
                                prefetch={true}
                                href={`/course/${course_id}/discussion/${thread.id}`}
                                key={thread.id}
                                legacyBehavior>
                                <DiscussionPostSummary thread={thread} topic={topic} />
                            </Link>
                        );
                    })}
                </Stack>
            </Box>
            <Box>
                <Heading size="lg" mb={4}>Open Help Requests</Heading>
                <Stack spaceY={4}>
                    {helpRequests?.map(request => (
                        <CardRoot key={request.id}>
                            <CardHeader>
                                <Link href={`/course/${course_id}/help/${request.id}`} legacyBehavior>
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