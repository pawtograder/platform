import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import Link from "@/components/ui/link";
import { COURSE_FEATURES, courseFeatureEnabled } from "@/lib/courseFeatures";
import { fetchManageAssignmentsOverview } from "@/lib/ssr-course-dashboard";
import { createClient } from "@/utils/supabase/server";
import { Alert, Table, Text } from "@chakra-ui/react";

export async function ManageAssignmentsTable({ courseId }: { courseId: number }) {
  const supabase = await createClient();
  const [{ data: assignmentRows, error: overviewError }, { data: courseRow }] = await Promise.all([
    fetchManageAssignmentsOverview(supabase, courseId),
    supabase.from("classes").select("features").eq("id", courseId).single()
  ]);

  if (overviewError) {
    return (
      <Alert.Root status="error" borderRadius="md">
        <Alert.Title>Could not load assignments</Alert.Title>
        <Alert.Description>{overviewError}</Alert.Description>
      </Alert.Root>
    );
  }

  // Mastery-grading courses grade against the suggested due date, so staff need to see it to
  // know when grading can start (#894). Gated on the same course flag that drives the
  // student-facing emphasis, so the two views agree on which date the course runs on.
  const showSuggestedDueDate = courseFeatureEnabled(
    courseRow?.features as { name: string; enabled: boolean }[] | null,
    COURSE_FEATURES.SUGGESTED_DUE_DATE
  );
  const columnCount = showSuggestedDueDate ? 5 : 4;

  return (
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>Title</Table.ColumnHeader>
          <Table.ColumnHeader>Release Date</Table.ColumnHeader>
          {showSuggestedDueDate && <Table.ColumnHeader>Suggested Due Date</Table.ColumnHeader>}
          <Table.ColumnHeader>Due Date</Table.ColumnHeader>
          <Table.ColumnHeader>Open Regrade Requests</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {assignmentRows?.length === 0 ? (
          <Table.Row>
            <Table.Cell colSpan={columnCount}>
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
              {showSuggestedDueDate && (
                <Table.Cell>
                  {assignment.suggested_due_date ? (
                    <TimeZoneAwareDate date={assignment.suggested_due_date} format="Pp" />
                  ) : (
                    <Text color="fg.muted">N/A</Text>
                  )}
                </Table.Cell>
              )}
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
