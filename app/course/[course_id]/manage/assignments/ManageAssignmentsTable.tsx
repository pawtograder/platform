import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import Link from "@/components/ui/link";
import { getCachedManageAssignmentsOverview } from "@/lib/course-dashboard-cache";
import { Table } from "@chakra-ui/react";
import { headers } from "next/headers";

export async function ManageAssignmentsTable({ courseId }: { courseId: number }) {
  const headersList = await headers();
  const userId = headersList.get("X-User-ID") ?? "";
  const { data: assignmentRows, error: overviewError } = await getCachedManageAssignmentsOverview(courseId, userId);

  if (overviewError) {
    // eslint-disable-next-line no-console
    console.error("Unable to fetch assignments:", overviewError);
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
        {assignmentRows?.map((assignment) => (
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
        ))}
      </Table.Body>
    </Table.Root>
  );
}
