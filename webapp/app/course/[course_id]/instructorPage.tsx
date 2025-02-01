import { isInstructor } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server"
import { Table } from "@chakra-ui/react";
import { jwtDecode } from "jwt-decode";
import Link from "next/link";
import { useRouter } from "next/navigation"

export default async function CourseLanding({
    course_id }: {
        course_id: number
    }) {
    const client = await createClient();
    const assignments = await client.from("assignments").select("*, submissions(count)").eq("class_id", course_id);

    let actions = <></>;
    actions = <Link href={`/course/${course_id}/new-assignment`}>New Assignment</Link>
    return <div>{actions}
        <Table.Root>
            <Table.Header>
                <Table.Row>
                    <Table.ColumnHeader>Title</Table.ColumnHeader>
                    <Table.ColumnHeader>Release Date</Table.ColumnHeader>
                    <Table.ColumnHeader>Due Date</Table.ColumnHeader>
                    <Table.ColumnHeader>Submissions</Table.ColumnHeader>
                </Table.Row>
            </Table.Header>
            <Table.Body>
                {assignments?.data?.map((assignment) => (
                    <Table.Row key={assignment.id}>
                        <Table.Cell><Link href={`/course/${course_id}/assignments/${assignment.id}`}>{assignment.title}</Link></Table.Cell>
                        <Table.Cell>{assignment.release_date}</Table.Cell>
                        <Table.Cell>{assignment.due_date}</Table.Cell>
                        <Table.Cell>{assignment.submissions[0].count}</Table.Cell>
                    </Table.Row>
                ))}
            </Table.Body>
        </Table.Root>
    </div>

}