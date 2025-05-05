import { createClient } from "@/utils/supabase/server";
import { Box, Button, HStack, Table } from "@chakra-ui/react";
import Link from "@/components/ui/link";
import NextLink from "next/link";
import { autograderSyncStaffTeam } from "@/lib/edgeFunctions";
import SyncStaffTeamButton from "./syncStaffTeamButton";

function numUniqueSubmissions(submissions: { profile_id: string | null; assignment_group_id: number | null }[]) {
  return new Set(submissions.map((s) => `profile=${s.profile_id},group=${s.assignment_group_id}`)).size;
}

export default async function ManageAssignmentsPage({ params }: { params: Promise<{ course_id: string }> }) {
  const { course_id } = await params;
  const client = await createClient();
  const assignments = await client
    .from("assignments")
    .select("*, submissions(profile_id, assignment_group_id)")
    .eq("class_id", Number(course_id));

  let actions = <></>;
  actions = (
    <HStack p={2}>
      <Button size="xs" asChild variant="solid" colorPalette="green">
        <NextLink href={`/course/${course_id}/manage/assignments/new`}>New Assignment</NextLink>
      </Button>
      <SyncStaffTeamButton course_id={Number(course_id)} />
    </HStack>
  );
  return (
    <Box>
      {actions}
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
              <Table.Cell>
                <Link href={`/course/${course_id}/manage/assignments/${assignment.id}`}>{assignment.title}</Link>
              </Table.Cell>
              <Table.Cell>{assignment.release_date}</Table.Cell>
              <Table.Cell>{assignment.due_date}</Table.Cell>
              <Table.Cell>{numUniqueSubmissions(assignment.submissions)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
