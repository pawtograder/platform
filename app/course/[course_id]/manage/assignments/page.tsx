import Link from "@/components/ui/link";
import { createClient } from "@/utils/supabase/server";
import { Box, Button, HStack, Table } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { formatInTimeZone } from "date-fns-tz";
import NextLink from "next/link";
import SyncStaffTeamButton from "./syncStaffTeamButton";

/**
 * Renders the assignment management page for a specific course, displaying a table of assignments with relevant actions and statistics.
 *
 * Fetches class and assignment overview data for the given course, then displays assignment titles, release and due dates (formatted in the class's time zone), active submission counts, and open regrade request counts. Provides actions to create a new assignment and to sync the staff team.
 *
 * @param params - A promise resolving to an object containing the `course_id` of the course to manage assignments for.
 * @returns A React component rendering the assignments management interface for the specified course.
 */
export default async function ManageAssignmentsPage({ params }: { params: Promise<{ course_id: string }> }) {
  const { course_id } = await params;
  const client = await createClient();
  const { data: classes } = await client.from("classes").select("*").eq("id", Number(course_id));
  const assignments = await client
    .from("assignment_overview")
    .select("*")
    .eq("class_id", Number(course_id))
    .order("due_date", { ascending: false });

  if (assignments.error) {
    console.error(assignments.error);
  }

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
            <Table.ColumnHeader>Active Submissions</Table.ColumnHeader>
            <Table.ColumnHeader>Open Regrade Requests</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {assignments?.data?.map((assignment) => (
            <Table.Row key={assignment.id}>
              <Table.Cell>
                <Link href={`/course/${course_id}/manage/assignments/${assignment.id}`}>{assignment.title}</Link>
              </Table.Cell>
              <Table.Cell>
                {assignment.release_date
                  ? formatInTimeZone(
                      new TZDate(assignment.release_date),
                      classes?.[0]?.time_zone || "America/New_York",
                      "Pp"
                    )
                  : "N/A"}
              </Table.Cell>
              <Table.Cell>
                {assignment.due_date
                  ? formatInTimeZone(
                      new TZDate(assignment.due_date),
                      classes?.[0]?.time_zone || "America/New_York",
                      "Pp"
                    )
                  : "N/A"}
              </Table.Cell>
              <Table.Cell>
                <Link href={`/course/${course_id}/manage/assignments/${assignment.id}`}>
                  {assignment.active_submissions_count}
                </Link>
              </Table.Cell>
              <Table.Cell>
                <Link href={`/course/${course_id}/manage/assignments/${assignment.id}/regrade-requests`}>
                  {assignment.open_regrade_requests_count}
                </Link>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
