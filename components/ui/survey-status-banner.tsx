"use client";

import { createClient } from "@/utils/supabase/client";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Box, Badge, HStack, Text, VStack, Icon } from "@chakra-ui/react";
import Link from "@/components/ui/link";
import { useEffect, useState } from "react";
import { FaClipboardList, FaCheckCircle, FaExclamationCircle } from "react-icons/fa";
import { formatDistanceToNow, isPast } from "date-fns";

type SurveyStatus = {
  survey_id: string;
  survey_title: string;
  survey_status: string;
  is_submitted: boolean;
  submitted_at: string | null;
  due_date: string | null;
  available_at: string | null;
};

export function SurveyStatusBanner({
  assignmentId,
  courseId
}: {
  assignmentId: number;
  courseId: number;
}) {
  const { private_profile_id } = useClassProfiles();
  const [surveys, setSurveys] = useState<SurveyStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSurveyStatus() {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("get_survey_status_for_assignment", {
        p_assignment_id: assignmentId,
        p_profile_id: private_profile_id
      });
      if (!error && data) {
        setSurveys(data);
      }
      setLoading(false);
    }
    if (private_profile_id) {
      fetchSurveyStatus();
    }
  }, [assignmentId, private_profile_id]);

  if (loading || surveys.length === 0) return null;

  return (
    <VStack w="100%" gap={2} px={3} py={2}>
      {surveys.map((survey) => {
        const isOverdue = survey.due_date && isPast(new Date(survey.due_date));
        const isAvailable = !survey.available_at || isPast(new Date(survey.available_at));

        return (
          <Box
            key={survey.survey_id}
            w="100%"
            p={3}
            borderRadius="md"
            border="1px solid"
            borderColor={survey.is_submitted ? "green.300" : isOverdue ? "red.300" : "blue.300"}
            bg={survey.is_submitted ? "green.50" : isOverdue ? "red.50" : "blue.50"}
            _dark={{
              bg: survey.is_submitted ? "green.900" : isOverdue ? "red.900" : "blue.900",
              borderColor: survey.is_submitted ? "green.600" : isOverdue ? "red.600" : "blue.600"
            }}
          >
            <HStack justify="space-between" align="center">
              <HStack gap={3}>
                <Icon fontSize="lg" color={survey.is_submitted ? "green.500" : isOverdue ? "red.500" : "blue.500"}>
                  {survey.is_submitted ? <FaCheckCircle /> : isOverdue ? <FaExclamationCircle /> : <FaClipboardList />}
                </Icon>
                <VStack align="start" gap={0}>
                  <HStack gap={2}>
                    <Text fontWeight="semibold" fontSize="sm">
                      Survey: {survey.survey_title}
                    </Text>
                    <Badge
                      colorPalette={survey.is_submitted ? "green" : isOverdue ? "red" : "yellow"}
                      size="sm"
                    >
                      {survey.is_submitted ? "Completed" : isOverdue ? "Overdue" : "Pending"}
                    </Badge>
                  </HStack>
                  {survey.due_date && (
                    <Text fontSize="xs" color="fg.muted">
                      {survey.is_submitted
                        ? `Submitted ${survey.submitted_at ? formatDistanceToNow(new Date(survey.submitted_at), { addSuffix: true }) : ""}`
                        : isOverdue
                          ? `Was due ${formatDistanceToNow(new Date(survey.due_date), { addSuffix: true })}`
                          : `Due ${formatDistanceToNow(new Date(survey.due_date), { addSuffix: true })}`}
                    </Text>
                  )}
                </VStack>
              </HStack>
              {isAvailable && !survey.is_submitted && (
                <Link href={`/course/${courseId}/surveys/${survey.survey_id}`}>
                  <Badge colorPalette="blue" variant="solid" cursor="pointer">
                    Take Survey
                  </Badge>
                </Link>
              )}
              {survey.is_submitted && (
                <Link href={`/course/${courseId}/surveys/${survey.survey_id}`}>
                  <Badge colorPalette="green" variant="outline" cursor="pointer">
                    View Response
                  </Badge>
                </Link>
              )}
            </HStack>
          </Box>
        );
      })}
    </VStack>
  );
}
