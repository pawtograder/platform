import { Button } from "@/components/ui/button";
import { formatDueDate } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";
import { Box, DataList, DataListRoot, Heading, HStack, Icon, Table, VStack } from "@chakra-ui/react";
import { CreateGitHubRepos } from "./CreateGitHubRepos";
import Link from "@/components/ui/link";
import NextLink from "next/link";
import { FiStar } from "react-icons/fi";
import { FaStar } from "react-icons/fa";
import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import AssignmentsTable from "./assignmentsTable";
export default async function AssignmentHome({ params,
}: {
    params: Promise<{ course_id: string, assignment_id: string }>
}) {
    const { course_id, assignment_id } = await params;
    const client = await createClient();
    const session = await client.auth.getSession();
    const { data: assignment } = await client.from("assignments").select("*").eq("id", Number.parseInt(assignment_id)).single();
    const { data: roster, error } = await client.from("user_roles").
        select("role,user_id, profiles!private_profile_id(*)").
        // select("*").
        // eq("role", "student").
        eq("class_id", Number.parseInt(course_id));
    const { error: subError, data: submissions } = await client.from("submissions_agg").select("*").eq("assignment_id", Number.parseInt(assignment_id));
    const {error: activeSubmissionsError, data: activeSubmissions} = await client.from("submissions").select("*, grader_results(*), submission_reviews!submissions_grading_review_id_fkey(*)")
    .eq("assignment_id", Number.parseInt(assignment_id))
    .eq("is_active", true);
    if (!assignment) {
        return <div>Assignment not found</div>
    }
    const showGroupColumn = assignment.group_config !== "individual";

    return (
        <Box borderColor="border.muted"
            borderWidth="2px"
            borderRadius="md"
        >
            <Box p={4}>
                <HStack justify="space-between">
                    <VStack align="flex-start">
                        <Heading size="lg">Assignment: {assignment.title}</Heading>
                        <DataList.Root orientation="horizontal">
                            <DataList.Item>
                                <DataList.ItemLabel>Released</DataList.ItemLabel>
                                <DataList.ItemValue>{formatDueDate(assignment.release_date)}</DataList.ItemValue>
                            </DataList.Item>
                            <DataList.Item>
                                <DataList.ItemLabel>Due</DataList.ItemLabel>
                                <DataList.ItemValue>{formatDueDate(assignment.due_date)}</DataList.ItemValue>
                            </DataList.Item>
                        </DataList.Root>
                    </VStack>
                </HStack>
            </Box>
            <HStack justify="flex-start" width="100%" border="1px solid" borderColor="border.muted" borderRadius="md" p={2} m={1} bg="bg.subtle">
                <NextLink href={`/course/${course_id}/manage/assignments/${assignment_id}/edit`}><Button size="xs" variant="surface">Edit Assignment</Button></NextLink>
                <NextLink href={`/course/${course_id}/manage/assignments/${assignment_id}/autograder`}><Button size="xs" variant="surface">Configure Autograder</Button></NextLink>
                <NextLink href={`/course/${course_id}/manage/assignments/${assignment_id}/rubric`}><Button size="xs" variant="surface">Configure Rubric</Button></NextLink>
                {assignment.group_config !== "individual" && <NextLink href={`/course/${course_id}/manage/assignments/${assignment_id}/groups`}><Button size="xs" variant="surface">Manage Groups</Button></NextLink>}
                <CreateGitHubRepos courseId={Number.parseInt(course_id)} assignmentId={Number.parseInt(assignment_id)} />
            </HStack>
            <AssignmentsTable />
        </Box>
    );
}