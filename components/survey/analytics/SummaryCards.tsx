"use client";

import type { QuestionStats } from "@/types/survey-analytics";
import { Card, HStack, Text } from "@chakra-ui/react";

type SummaryCardsProps = {
  totalResponses: number;
  totalStudents?: number;
  courseStats: Record<string, QuestionStats>;
  selectedQuestion: string | null;
  questionTitle: string;
  alertsCount: number;
  obfuscateStats?: boolean;
};

export function SummaryCards({
  totalResponses,
  totalStudents = 0,
  courseStats,
  selectedQuestion,
  questionTitle,
  alertsCount,
  obfuscateStats = false
}: SummaryCardsProps) {
  const responseRate = totalStudents > 0 ? Math.round((totalResponses / totalStudents) * 100) : 0;
  const stats = selectedQuestion ? courseStats[selectedQuestion] : null;
  const courseMean = stats?.mean ?? 0;

  return (
    <HStack gap={4} flexWrap="wrap">
      <Card.Root flex="1" minW="140px">
        <Card.Body>
          <Text fontSize="sm" color="fg.muted" mb={1}>
            Total Responses
          </Text>
          <Text fontSize="2xl" fontWeight="bold">
            {totalResponses}
            {totalStudents > 0 && (
              <Text as="span" fontSize="sm" color="fg.muted" ml={2}>
                ({responseRate}%)
              </Text>
            )}
          </Text>
        </Card.Body>
      </Card.Root>

      {!obfuscateStats && selectedQuestion && stats && (
        <Card.Root flex="1" minW="140px">
          <Card.Body>
            <Text fontSize="sm" color="fg.muted" mb={1}>
              Course Avg: {questionTitle}
            </Text>
            <Text fontSize="2xl" fontWeight="bold">
              {courseMean.toFixed(2)}
            </Text>
          </Card.Body>
        </Card.Root>
      )}

      {!obfuscateStats && alertsCount > 0 && (
        <Card.Root flex="1" minW="140px" borderColor="orange.500" borderWidth="1px">
          <Card.Body>
            <Text fontSize="sm" color="fg.muted" mb={1}>
              Needs Attention
            </Text>
            <Text fontSize="2xl" fontWeight="bold" color="orange.600">
              {alertsCount} group{alertsCount !== 1 ? "s" : ""}
            </Text>
          </Card.Body>
        </Card.Root>
      )}
    </HStack>
  );
}
