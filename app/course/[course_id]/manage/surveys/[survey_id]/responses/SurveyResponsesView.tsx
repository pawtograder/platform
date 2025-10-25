"use client";

import { Box, Container, Heading, Text, VStack, HStack, Table, Button } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { formatInTimeZone } from "date-fns-tz";
import { TZDate } from "@date-fns/tz";
import { differenceInMinutes } from "date-fns";
import { useRouter } from "next/navigation";

type SurveyResponse = {
  id: string;
  survey_id: string;
  student_id: string; // User auth UUID (auth.uid())
  answers: {
    satisfaction?: string;
    helpful_aspects?: string;
    comments?: string;
    [key: string]: any; // Allow for other properties
  };
  submitted_at: string;
  updated_at: string;
  is_submitted: boolean;
  profiles: {
    name: string;
  };
};

type SurveyResponsesViewProps = {
  courseId: string;
  surveyId: string; // The UUID
  surveyTitle: string;
  surveyVersion: number;
  surveyStatus: string;
  surveyJson: any; // The JSON configuration of the survey
  responses: SurveyResponse[];
  totalStudents: number;
};

export default function SurveyResponsesView({
  courseId,
  surveyId,
  surveyTitle,
  surveyVersion,
  surveyStatus,
  surveyJson,
  responses,
  totalStudents
}: SurveyResponsesViewProps) {
  const router = useRouter();
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headerBgColor = useColorModeValue("#F2F2F2", "#0D0D0D");
  const headerTextColor = useColorModeValue("#1A202C", "#9CA3AF");
  const tableRowBg = useColorModeValue("#E5E5E5", "#1A1A1A");
  const emptyStateTextColor = useColorModeValue("#6B7280", "#718096");

  const totalResponses = responses.length;
  const responseRate = totalStudents > 0 ? ((totalResponses / totalStudents) * 100).toFixed(0) : 0;

  // Calculate average completion time
  let avgCompletionTime = "—";
  if (totalResponses > 0) {
    const totalMinutes = responses.reduce((sum, response) => {
      const start = new Date(response.updated_at);
      const end = new Date(response.submitted_at);
      return sum + differenceInMinutes(end, start);
    }, 0);
    const avgMinutes = totalMinutes / totalResponses;
    const avgHours = Math.floor(avgMinutes / 60);
    const remainingMinutes = Math.round(avgMinutes % 60);
    avgCompletionTime = `${avgHours > 0 ? `${avgHours}:` : ""}${remainingMinutes.toString().padStart(2, "0")}`;
  }

  return (
    <Container py={8} maxW="1200px" my={2}>
      <VStack align="stretch" gap={4} w="100%">
        {/* Title */}
        <Heading size="2xl" color={textColor}>
          Survey Responses: {surveyTitle}
        </Heading>

        {/* Action Buttons */}
        <HStack justify="space-between" mb={8}>
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor={borderColor}
            color={textColor}
            _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
            onClick={() => router.push(`/course/${courseId}/manage/surveys`)}
          >
            ← Back to Surveys
          </Button>
          <Button size="sm" variant="solid" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }}>
            Export to CSV
          </Button>
        </HStack>
      </VStack>

      <Text color={textColor} mb={6}>
        Viewing all responses for version {surveyVersion}
      </Text>

      {/* Summary Cards */}
      <HStack gap={4} mb={8} justify="flex-start" wrap="wrap">
        <Box
          bg={cardBgColor}
          border="1px solid"
          borderColor={borderColor}
          borderRadius="lg"
          p={4}
          minW="200px"
          flex="1"
        >
          <Text fontSize="sm" color={headerTextColor} mb={1}>
            TOTAL RESPONSES
          </Text>
          <Text fontSize="2xl" fontWeight="bold" color={textColor}>
            {totalResponses}
          </Text>
        </Box>
        <Box
          bg={cardBgColor}
          border="1px solid"
          borderColor={borderColor}
          borderRadius="lg"
          p={4}
          minW="200px"
          flex="1"
        >
          <Text fontSize="sm" color={headerTextColor} mb={1}>
            RESPONSE RATE
          </Text>
          <Text fontSize="2xl" fontWeight="bold" color={textColor}>
            {responseRate}%
          </Text>
        </Box>
        <Box
          bg={cardBgColor}
          border="1px solid"
          borderColor={borderColor}
          borderRadius="lg"
          p={4}
          minW="200px"
          flex="1"
        >
          <Text fontSize="sm" color={headerTextColor} mb={1}>
            AVG. COMPLETION TIME
          </Text>
          <Text fontSize="2xl" fontWeight="bold" color={textColor}>
            {avgCompletionTime}
          </Text>
        </Box>
      </HStack>

      {/* Responses Table */}
      <Box border="1px solid" borderColor={borderColor} borderRadius="lg" overflow="hidden" overflowX="auto">
        <Table.Root variant="outline" size="md">
          <Table.Header>
            <Table.Row bg={headerBgColor}>
              <Table.ColumnHeader
                color={headerTextColor}
                fontSize="xs"
                fontWeight="semibold"
                textTransform="uppercase"
                py={3}
                pl={6}
              >
                STUDENT NAME
              </Table.ColumnHeader>
              <Table.ColumnHeader
                color={headerTextColor}
                fontSize="xs"
                fontWeight="semibold"
                textTransform="uppercase"
                py={3}
              >
                SUBMITTED AT
              </Table.ColumnHeader>
              <Table.ColumnHeader
                color={headerTextColor}
                fontSize="xs"
                fontWeight="semibold"
                textTransform="uppercase"
                py={3}
              >
                Q1: SATISFACTION
              </Table.ColumnHeader>
              <Table.ColumnHeader
                color={headerTextColor}
                fontSize="xs"
                fontWeight="semibold"
                textTransform="uppercase"
                py={3}
              >
                Q2: HELPFUL ASPECTS
              </Table.ColumnHeader>
              <Table.ColumnHeader
                color={headerTextColor}
                fontSize="xs"
                fontWeight="semibold"
                textTransform="uppercase"
                py={3}
                pr={6}
              >
                Q3: COMMENTS
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {totalResponses === 0 ? (
              <Table.Row bg={tableRowBg} borderColor={borderColor}>
                <Table.Cell colSpan={5} py={4} textAlign="center">
                  <Text color={emptyStateTextColor}>Students haven't submitted any responses to this survey.</Text>
                </Table.Cell>
              </Table.Row>
            ) : (
              responses.map((response) => (
                <Table.Row key={response.id} bg={tableRowBg} borderColor={borderColor}>
                  <Table.Cell py={4} pl={6}>
                    <Text color={textColor}>{response.profiles?.name || "N/A"}</Text>
                  </Table.Cell>
                  <Table.Cell py={4}>
                    <Text color={textColor}>
                      {formatInTimeZone(new TZDate(response.submitted_at), "America/New_York", "MMM d, yyyy, h:mm a")}
                    </Text>
                  </Table.Cell>
                  <Table.Cell py={4}>
                    <Text color={textColor}>{response.answers?.satisfaction || "—"}</Text>
                  </Table.Cell>
                  <Table.Cell py={4}>
                    <Text color={textColor}>{response.answers?.helpful_aspects || "—"}</Text>
                  </Table.Cell>
                  <Table.Cell py={4} pr={6}>
                    <Text color={textColor}>{response.answers?.comments || "—"}</Text>
                  </Table.Cell>
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table.Root>
      </Box>
    </Container>
  );
}
