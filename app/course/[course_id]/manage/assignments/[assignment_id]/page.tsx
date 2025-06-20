import { createClient } from "@/utils/supabase/server";
import { Box, DataList, HStack, VStack } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { formatInTimeZone } from "date-fns-tz";
import AssignmentsTable from "./assignmentsTable";
export default async function AssignmentHome({
  params
}: {
  params: Promise<{ course_id: string; assignment_id: string }>;
}) {
  const { assignment_id } = await params;
  const client = await createClient();
  const { data: assignment } = await client
    .from("assignments")
    .select("*, classes(time_zone)")
    .eq("id", Number.parseInt(assignment_id))
    .single();
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
            </DataList.Root>
          </VStack>
        </HStack>
      </Box>
      <AssignmentsTable />
    </Box>
  );
}
