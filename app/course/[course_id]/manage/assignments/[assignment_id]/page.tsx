import { Button } from "@/components/ui/button";
import { formatDueDate } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";
import { Box, DataList, HStack, VStack } from "@chakra-ui/react";
import NextLink from "next/link";
import AssignmentsTable from "./assignmentsTable";
import { CreateGitHubRepos } from "./CreateGitHubRepos";
export default async function AssignmentHome({ params,
}: {
    params: Promise<{ course_id: string, assignment_id: string }>
}) {
    const { course_id, assignment_id } = await params;
    const client = await createClient();
    const { data: assignment } = await client.from("assignments").select("*").eq("id", Number.parseInt(assignment_id)).single();
    if (!assignment) {
        return <div>Assignment not found</div>
    }

    return (
        <Box
        >
            <Box p={4}>
                <HStack justify="space-between">
                    <VStack align="flex-start">
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
            <AssignmentsTable />
        </Box>
    );
}