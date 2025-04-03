import { Button } from "@/components/ui/button";
import { formatDueDate } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";
import { Box, DataList, DataListRoot, Heading, HStack, Table, VStack } from "@chakra-ui/react";
import { CreateGitHubRepos } from "./CreateGitHubRepos";
import Link from "@/components/ui/link";
import NextLink from "next/link";
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
                    {assignment.group_config !== "individual" && <NextLink href={`/course/${course_id}/manage/assignments/${assignment_id}/groups`}><Button size="xs" variant="surface">Manage Groups</Button></NextLink>}
                    <CreateGitHubRepos courseId={Number.parseInt(course_id)} assignmentId={Number.parseInt(assignment_id)} />
                </HStack>
            <Table.Root striped>
                <Table.Header>
                    <Table.Row>
                        <Table.ColumnHeader>Student</Table.ColumnHeader>
                        {showGroupColumn && <Table.ColumnHeader>Group</Table.ColumnHeader>}
                        <Table.ColumnHeader>Submission Count</Table.ColumnHeader>
                        <Table.ColumnHeader>Latest Autograde score</Table.ColumnHeader>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {roster?.map((user) => {
                        const submisison = submissions?.find((sub) => sub.profile_id === user.profiles!.id);
                        return (<Table.Row key={user.user_id}>
                            <Table.Cell>
                                {submisison ? <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submisison?.id}`}>{user.profiles?.name}</Link>
                                    : user.profiles?.name}
                            </Table.Cell>
                            {showGroupColumn && <Table.Cell>{submisison?.groupname}</Table.Cell>}
                            <Table.Cell>{submisison?.submissioncount}</Table.Cell>
                            <Table.Cell>{submisison?.score}</Table.Cell>
                        </Table.Row>
                        )
                    })}
                </Table.Body>

            </Table.Root>
        </Box>
    );
}