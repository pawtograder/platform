"use client";
import { useSelfReviewSettings } from "@/hooks/useAssignment";
import { useAssignmentDueDate } from "@/hooks/useCourseController";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Flex, Skeleton, Text } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useOne } from "@refinedev/core";
import { addHours } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useParams } from "next/navigation";

export default function SelfReviewDueDateInformation() {
  const settings = useSelfReviewSettings();
  const { assignment_id } = useParams();
  const { data: assignment } = useOne<Assignment>({
    resource: "assignments",
    id: assignment_id?.toString()
  });

  const { dueDate, time_zone } = useAssignmentDueDate(assignment?.data ?? ({} as Assignment));
  if (!dueDate) {
    return <Skeleton height="20px" width="80px" />;
  }
  const evalDeadline = addHours(dueDate, settings.deadline_offset ?? 0);

  return (
    <Flex>
      {!settings.enabled ? (
        <Text>There is no self review for this assignment</Text>
      ) : new TZDate(dueDate, time_zone) < new TZDate(new Date(), time_zone) ? (
        <Text>
          Due {formatInTimeZone(evalDeadline, time_zone || "America/New_York", "MMM d h:mm aaa")} ({time_zone})
        </Text>
      ) : (
        <Text>Self review deadline is offset 2 hours from assignment deadline. Link will appear here.</Text>
      )}
    </Flex>
  );
}
