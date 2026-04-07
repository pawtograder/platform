import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import Link from "@/components/ui/link";
import { fetchManageAssignmentsOverview } from "@/lib/ssr-course-dashboard";
import { createClient } from "@/utils/supabase/server";
import { Alert, Table, Text } from "@chakra-ui/react";

export async function ManageAssignmentsTable({ courseId }: { courseId: number }) {
  const supabase = await createClient();
  const { data: assignmentRows, error: overviewError } = await fetchManageAssignmentsOverview(supabase, courseId);

  if (overviewError) {
    return (
      <Alert.Root status="error" borderRadius="md">
        <Alert.Title>Could not load assignments</Alert.Title>
        <Alert.Description>{overviewError}</Alert.Description>
      </Alert.Root>
    );
  }

  return (
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>Title</Table.ColumnHeader>
          <Table.ColumnHeader>Release Date</Table.ColumnHeader>
          <Table.ColumnHeader>Due Date</Table.ColumnHeader>
          <Table.ColumnHeader>Open Regrade Requests</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {assignmentRows?.length === 0 ? (
          <Table.Row>
            <Table.Cell colSpan={4}>
              <Text color="fg.muted" fontSize="sm">
                No assignments in this course.
              </Text>
            </Table.Cell>
          </Table.Row>
        ) : (
          assignmentRows?.map((assignment) => (
            <Table.Row key={assignment.id}>
              <Table.Cell>
                <Link href={`/course/${courseId}/manage/assignments/${assignment.id}`}>{assignment.title}</Link>
              </Table.Cell>
              <Table.Cell>
                {assignment.release_date ? <TimeZoneAwareDate date={assignment.release_date} format="Pp" /> : "N/A"}
              </Table.Cell>
              <Table.Cell>
                {assignment.due_date ? <TimeZoneAwareDate date={assignment.due_date} format="Pp" /> : "N/A"}
              </Table.Cell>
              <Table.Cell>
                <Link href={`/course/${courseId}/manage/assignments/${assignment.id}/regrade-requests`}>
                  {assignment.open_regrade_requests_count}
                </Link>
              </Table.Cell>
            </Table.Row>
          ))
        )}
      </Table.Body>
    </Table.Root>
  );
}
