"use client";

import { useNow } from "@/hooks/useNow";
import { useRefreshWhenShown } from "@/hooks/useRefreshWhenShown";
import type { Survey } from "@/types/survey";
import { Badge, Box, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { formatDistance } from "date-fns";
import { FaClipboardList, FaExclamationCircle } from "react-icons/fa";
import SurveyDashboardCta from "./SurveyDashboardCta";

export type SurveyToComplete = Pick<Survey, "id" | "title" | "due_date"> & { inProgress: boolean };

function sortIncompleteSurveysForBanner(surveys: SurveyToComplete[], now: number): SurveyToComplete[] {
  return [...surveys].sort((a, b) => {
    const aTime = a.due_date ? new Date(a.due_date).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.due_date ? new Date(b.due_date).getTime() : Number.POSITIVE_INFINITY;
    const aOver = a.due_date != null && aTime < now;
    const bOver = b.due_date != null && bTime < now;
    if (aOver !== bOver) {
      return aOver ? -1 : 1;
    }
    return aTime - bTime;
  });
}

/**
 * The student dashboard's "Surveys to complete" cards. A client component so the countdown,
 * the Overdue state and the order follow the clock while the dashboard stays open; the server
 * renders it once with `renderedAt`, its own time, which `useNow` starts from and the refresh
 * throttle counts from.
 *
 * Which surveys are listed is still decided by the server: `surveys_select_students` hides a
 * survey until its `available_at`, so one that opens later is never in `surveys`. It arrives
 * through `useRefreshWhenShown`, when a hidden dashboard is shown again.
 */
export default function SurveysToComplete({
  courseId,
  surveys,
  renderedAt
}: {
  courseId: number;
  surveys: SurveyToComplete[];
  renderedAt: number;
}) {
  const now = useNow(renderedAt);
  useRefreshWhenShown(renderedAt);

  if (surveys.length === 0) {
    return null;
  }

  return (
    <Box w="100%" mb={3}>
      <Text fontWeight="semibold" fontSize="sm" mb={2} color="fg.muted">
        Surveys to complete
      </Text>
      <VStack gap={2} align="stretch">
        {sortIncompleteSurveysForBanner(surveys, now).map((survey) => {
          const dueAt = survey.due_date ? new Date(survey.due_date) : null;
          const isOverdue = dueAt != null && dueAt.getTime() < now;
          const inProgress = survey.inProgress;
          const href = `/course/${courseId}/surveys/${survey.id}`;
          return (
            <Box
              key={survey.id}
              w="100%"
              p={3}
              borderRadius="md"
              border="1px solid"
              borderColor={isOverdue ? "red.300" : "blue.300"}
              bg={isOverdue ? "red.50" : "blue.50"}
              _dark={{
                bg: isOverdue ? "red.900" : "blue.900",
                borderColor: isOverdue ? "red.600" : "blue.600"
              }}
            >
              <HStack justify="space-between" align="center" flexWrap="wrap" gap={3}>
                <HStack gap={3} align="flex-start">
                  <Icon fontSize="lg" color={isOverdue ? "red.500" : "blue.500"} mt={0.5}>
                    {isOverdue ? <FaExclamationCircle /> : <FaClipboardList />}
                  </Icon>
                  <VStack align="start" gap={0}>
                    <HStack gap={2} flexWrap="wrap">
                      <Text fontWeight="semibold" fontSize="sm">
                        {survey.title ?? "Untitled survey"}
                      </Text>
                      <Badge colorPalette={isOverdue ? "red" : inProgress ? "yellow" : "blue"} size="sm">
                        {isOverdue ? "Overdue" : inProgress ? "In progress" : "Pending"}
                      </Badge>
                    </HStack>
                    {dueAt && (
                      <Text fontSize="xs" color="fg.muted">
                        {isOverdue
                          ? `Was due ${formatDistance(dueAt, now, { addSuffix: true })}`
                          : `Due ${formatDistance(dueAt, now, { addSuffix: true })}`}
                      </Text>
                    )}
                  </VStack>
                </HStack>
                <SurveyDashboardCta
                  href={href}
                  label={inProgress ? "Continue" : "Take survey"}
                  ariaLabel={`${inProgress ? "Continue" : "Take survey"}: ${survey.title ?? "Untitled survey"}`}
                  colorPalette={isOverdue ? "red" : "blue"}
                />
              </HStack>
            </Box>
          );
        })}
      </VStack>
    </Box>
  );
}
