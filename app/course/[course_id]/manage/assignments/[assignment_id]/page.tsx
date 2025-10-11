"use client";

import { useAssignmentController, useMyReviewAssignments } from "@/hooks/useAssignment";
import { Box, DataList, HStack, Link, Tabs, VStack } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { formatInTimeZone } from "date-fns-tz";
import AssignmentsTable from "./assignmentsTable";
import ReviewAssignmentsTable from "./reviewAssignmentsTable";
import { useCourseController } from "@/hooks/useCourseController";

export default function AssignmentHome() {
  const controller = useAssignmentController();
  const assignment = controller.assignment;
  const myReviewAssignments = useMyReviewAssignments();
  const hasReviewAssignments = myReviewAssignments.length > 0;
  const { course } = useCourseController();

  if (!assignment) {
    return <div>Assignment not found</div>;
  }

  // Get the time zone - need to safely access the classes property
  const timeZone = course.time_zone;

  // Get the grader repo - need to safely access the autograder property
  const graderRepo = undefined; //assignment.autograder?.grader_repo;

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
                    ? formatInTimeZone(new TZDate(assignment.release_date), timeZone || "America/New_York", "Pp")
                    : "N/A"}
                </DataList.ItemValue>
              </DataList.Item>
              <DataList.Item>
                <DataList.ItemLabel>Due</DataList.ItemLabel>
                <DataList.ItemValue>
                  {assignment.due_date
                    ? formatInTimeZone(new TZDate(assignment.due_date), timeZone || "America/New_York", "Pp")
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
                  <Link
                    href={`https://github.com/${course.github_org}/${course.slug}-solution-${assignment.slug}`}
                    target="_blank"
                  >
                    {course.github_org}/{course.slug}-solution-{assignment.slug}
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
