"use client";

import { Box, Container, Heading, Text, VStack, HStack, Table, Button, Badge } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { formatInTimeZone } from "date-fns-tz";
import { useRouter } from "next/navigation";
import PollAnalyticsChart from "./PollAnalyticsChart";

type PollResponse = {
  id: string;
  live_poll_id: string;
  public_profile_id: string;
  response: Record<string, unknown>;
  submitted_at: string | null;
  is_submitted: boolean;
  created_at: string;
  profile_name: string;
};

type PollResponsesViewProps = {
  courseId: string;
  pollId: string;
  pollTitle: string;
  pollQuestion: Record<string, unknown> | null;
  pollIsLive: boolean;
  responses: PollResponse[];
  timezone: string;
};

export default function PollResponsesView({
  courseId,
  pollId,
  pollTitle,
  pollQuestion,
  pollIsLive,
  responses,
  timezone
}: PollResponsesViewProps) {
  const router = useRouter();

  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const headerBgColor = useColorModeValue("#F2F2F2", "#0D0D0D");
  const headerTextColor = useColorModeValue("#1A202C", "#9CA3AF");
  const tableRowBg = useColorModeValue("#E5E5E5", "#1A1A1A");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "—";
    try {
      return formatInTimeZone(new Date(dateString), timezone, "MMM d, yyyy 'at' h:mm a");
    } catch {
      return dateString;
    }
  };

  const formatResponse = (response: Record<string, unknown>) => {
    try {
      // For poll responses, the response is typically a single value
      // Try to extract the actual answer
      const questionData = pollQuestion as any;
      if (questionData?.type === "multiple-choice" || questionData?.type === "single-choice") {
        const answer = response.poll_question;
        if (Array.isArray(answer)) {
          // Handle "other" responses
          return answer
            .map((item: string) => {
              if (item.startsWith("other:")) {
                return `Other: ${item.replace("other:", "")}`;
              }
              return item;
            })
            .join(", ");
        }
        // Handle single "other" response
        if (typeof answer === "string" && answer.startsWith("other:")) {
          return `Other: ${answer.replace("other:", "")}`;
        }
        return String(answer || "—");
      } else if (questionData?.type === "rating") {
        return String(response.poll_question || "—");
      } else if (questionData?.type === "text" || questionData?.type === "open-ended") {
        return String(response.poll_question || "—");
      }
      return JSON.stringify(response);
    } catch {
      return JSON.stringify(response);
    }
  };

  const submittedResponses = responses.filter((r) => r.is_submitted);

  return (
    <Container py={8} maxW="1200px" my={2}>
      <VStack align="stretch" gap={6}>
        <HStack justify="space-between">
          <VStack align="start" gap={2}>
            <Button
              variant="outline"
              size="sm"
              bg="transparent"
              borderColor={buttonBorderColor}
              color={buttonTextColor}
              _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
              onClick={() => router.push(`/course/${courseId}/manage/polls`)}
            >
              ← Back to Polls
            </Button>
            <Heading size="xl" color={textColor}>
              {pollTitle}
            </Heading>
            <HStack gap={2}>
              <Badge
                px={2}
                py={1}
                borderRadius="md"
                fontSize="xs"
                fontWeight="medium"
                bg={pollIsLive ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)"}
                color={pollIsLive ? "#22C55E" : "#EF4444"}
              >
                {pollIsLive ? "Live" : "Closed"}
              </Badge>
              <Text fontSize="sm" color={buttonTextColor}>
                {submittedResponses.length} response{submittedResponses.length !== 1 ? "s" : ""}
              </Text>
            </HStack>
          </VStack>
        </HStack>

        {submittedResponses.length === 0 ? (
          <Box
            bg={cardBgColor}
            border="1px solid"
            borderColor={borderColor}
            borderRadius="lg"
            p={12}
            textAlign="center"
          >
            <Text fontSize="lg" color={textColor} mb={2}>
              No responses yet
            </Text>
            <Text fontSize="sm" color={buttonTextColor}>
              {pollIsLive
                ? "Students can submit responses while the poll is live."
                : "This poll is closed and no longer accepting responses."}
            </Text>
          </Box>
        ) : (
          <>
            {/* Analytics Chart */}
            <PollAnalyticsChart pollQuestion={pollQuestion} responses={responses} />
          <Box border="1px solid" borderColor={borderColor} borderRadius="lg" overflow="hidden">
            <Table.Root size="sm">
              <Table.Header bg={headerBgColor}>
                <Table.Row>
                  <Table.ColumnHeader color={headerTextColor} fontWeight="semibold">
                    Student
                  </Table.ColumnHeader>
                  <Table.ColumnHeader color={headerTextColor} fontWeight="semibold">
                    Response
                  </Table.ColumnHeader>
                  <Table.ColumnHeader color={headerTextColor} fontWeight="semibold">
                    Submitted At
                  </Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {submittedResponses.map((response) => (
                  <Table.Row key={response.id} bg={tableRowBg}>
                    <Table.Cell>
                      <Text fontWeight="medium" color={textColor}>
                        {response.profile_name}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontSize="sm" color={textColor}>
                        {formatResponse(response.response)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontSize="xs" color={buttonTextColor}>
                        {formatDate(response.submitted_at)}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
          </>
        )}
      </VStack>
    </Container>
  );
}

