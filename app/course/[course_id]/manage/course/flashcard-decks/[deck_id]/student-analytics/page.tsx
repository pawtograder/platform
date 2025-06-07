"use client";

import { Heading, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import StudentCardAnalytics from "./studentCardAnalytics";

/**
 * Student analytics page for a flashcard deck
 * @returns The Student analytics page
 */
export default function StudentAnalyticsPage() {
  const params = useParams();
  const course_id = params.course_id as string;
  const deck_id = params.deck_id as string;

  return (
    <VStack align="stretch" gap={6}>
      <Heading size="lg">Student Analytics</Heading>
      <StudentCardAnalytics deckId={deck_id} courseId={course_id} />
    </VStack>
  );
}
