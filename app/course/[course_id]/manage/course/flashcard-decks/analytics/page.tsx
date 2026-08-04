"use client";

import { Heading, VStack, HStack, IconButton } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import DeckAnalytics from "./deckAnalytics";
import NextLink from "next/link";
import { FaArrowLeft } from "react-icons/fa";

/**
 * This component displays analytics for a flashcard deck.
 * It shows the number of times a deck has been viewed and the number of times a deck has been reset.
 * @returns The analytics data
 */
export default function FlashcardDeckAnalyticsPage() {
  const params = useParams();
  const course_id = params.course_id as string;

  return (
    <VStack align="stretch" w="100%" gap={6} p={6}>
      <HStack justifyContent="space-between" alignItems="center">
        <HStack>
          <IconButton asChild variant="ghost" size="sm">
            <NextLink
              href={`/course/${course_id}/manage/course/flashcard-decks`}
              aria-label="Go back to flashcard decks"
            >
              <FaArrowLeft />
            </NextLink>
          </IconButton>
          <Heading size="lg">Flashcard Deck Analytics</Heading>
        </HStack>
      </HStack>
      <DeckAnalytics courseId={course_id} />
    </VStack>
  );
}
