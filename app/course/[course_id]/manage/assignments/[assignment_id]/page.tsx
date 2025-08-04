import { getPrivateProfileId } from "@/lib/ssrUtils";
import { createClient } from "@/utils/supabase/server";
import { Box, DataList, HStack, Link, Tabs, VStack } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { formatInTimeZone } from "date-fns-tz";
import AssignmentsTable from "./assignmentsTable";
import ReviewAssignmentsTable from "./reviewAssignmentsTable";
export default async function AssignmentHome({
  params
}: {
  params: Promise<{ course_id: string; assignment_id: string }>;
}) {
  const { assignment_id, course_id } = await params;
  const client = await createClient();
  const { data: assignment } = await client
    .from("assignments")
    .select("*, classes(time_zone), autograder(grader_repo)")
    .eq("id", Number.parseInt(assignment_id))
    .single();
  const private_profile_id = await getPrivateProfileId(Number.parseInt(course_id));
  const hasReviewAssignments =
    (
      await client
        .from("review_assignments")
        .select("*")
        .eq("assignment_id", Number.parseInt(assignment_id))
        .eq("assignee_profile_id", private_profile_id ?? "")
        .limit(1)
    )?.data?.length ?? 0 > 0;

  if (!assignment) {
    return <div>Assignment not found</div>;
  }
  return (
    <Box>
      <Box>
        <HStack justify="space-between">
          <VStack align="flex-start">
            <DataList.Root orientation="horizontal">
              <DataList.Item>
                <DataList.ItemLabel>Released</DataList.ItemLabel>
                <DataList.ItemValue>
                  {assignment.release_date
                    ? formatInTimeZone(
                        new TZDate(assignment.release_date),
                        assignment.classes.time_zone || "America/New_York",
                        "Pp"
                      )
                    : "N/A"}
                </DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>Due</DataList.ItemLabel>
                <DataList.ItemValue>
                  {assignment.due_date
                    ? formatInTimeZone(
                        new TZDate(assignment.due_date),
                        assignment.classes.time_zone || "America/New_York",
                        "Pp"
                      )
                    : "N/A"}
                </DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>Handout repo</DataList.ItemLabel>
                <DataList.ItemValue>
                  <Link href={`https://github.com/${assignment.template_repo}`} target="_blank">
                    {assignment.template_repo}
                  </Link>
                </DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>Grader repo</DataList.ItemLabel>
                <DataList.ItemValue>
                  <Link href={`https://github.com/${assignment.autograder?.grader_repo}`} target="_blank">
                    {assignment.autograder?.grader_repo}
                  </Link>
                </DataList.ItemValue>
              </DataList.Item>
            </DataList.Root>
          </VStack>
        </HStack>
      </Box>
      <Tabs.Root
        defaultValue={hasReviewAssignments ? "assigned-grading" : "all-submissions"}
        variant="enclosed"
        lazyMount
        unmountOnExit
      >
        <Tabs.List>
          <Tabs.Trigger value="assigned-grading">Grading Assigned to You</Tabs.Trigger>
          <Tabs.Trigger value="all-submissions">All Submissions</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="assigned-grading">
          <ReviewAssignmentsTable />
        </Tabs.Content>
        <Tabs.Content value="all-submissions">
          <AssignmentsTable />
        </Tabs.Content>
      </Tabs.Root>
    </Box>
  );
}
