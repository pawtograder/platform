import { createClient } from "@/utils/supabase/server";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Table } from "@chakra-ui/react";
import { UnstableGetResult as GetResult } from '@supabase/postgrest-js';
type AssignmentWithRepositoryAndSubmissions = GetResult<Database['public'],
    Database['public']['Tables']['assignments']['Row'],
    'assignments', Database['public']['Tables']['assignments']['Relationships'], '*, submissions(*), repositories(*)'>;

export default async function AssignmentsPage({ params }: { params: Promise<{ course_id: string }> }) {
    const { course_id } = await params;
    const client = await createClient();
    const user = (await client.auth.getUser()).data.user;
    const assignments = await client.from("assignments")
            .select("*, submissions(*), repositories(*)")
                .eq("class_id", Number.parseInt(course_id))
                .eq("repositories.user_id", user!.id);

    const getLatestSubmission = (assignment: AssignmentWithRepositoryAndSubmissions) => {
        return assignment.submissions.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    }
    return (
        <div>
            <h1>Assignments</h1>
            <Table.Root>
                <Table.Header>
                    <Table.Row>
                        <Table.ColumnHeader>Title</Table.ColumnHeader>
                        <Table.ColumnHeader>Due Date</Table.ColumnHeader>
                        <Table.ColumnHeader>Latest Submission</Table.ColumnHeader>
                        <Table.ColumnHeader>GitHub Repo</Table.ColumnHeader>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {assignments.data?.map((assignment) => (
                        <Table.Row key={assignment.id}>
                            <Table.Cell>{assignment.title}</Table.Cell>
                            <Table.Cell>{assignment.due_date}</Table.Cell>
                            <Table.Cell>{getLatestSubmission(assignment)?.id}</Table.Cell>
                            <Table.Cell>{assignment.repositories[0]?.repository}</Table.Cell>
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table.Root>
        </div>
    );
}