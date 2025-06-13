"use client";

import { Heading, VStack, Tabs } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import StudentCardAnalytics from "./studentCardAnalytics";
import StudentDeckAnalytics from "./studentDeckAnalytics";

/**
 * Student analytics page for a flashcard deck
 * @returns The Student analytics page
 */
export default function StudentAnalyticsPage() {
  const params = useParams();
  const course_id = params["course_id"] as string;
  const deck_id = params["deck_id"] as string;

  return (
    <VStack align="stretch" gap={6}>
      <Heading size="lg">Student Analytics</Heading>
      <Tabs.Root defaultValue="aggregated">
        <Tabs.List>
          <Tabs.Trigger value="aggregated">Aggregated View</Tabs.Trigger>
          <Tabs.Trigger value="detailed">Detailed View</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="aggregated">
          <StudentDeckAnalytics deckId={deck_id} courseId={course_id} />
        </Tabs.Content>
        <Tabs.Content value="detailed">
          <StudentCardAnalytics deckId={deck_id} courseId={course_id} />
        </Tabs.Content>
      </Tabs.Root>
    </VStack>
  );
}
