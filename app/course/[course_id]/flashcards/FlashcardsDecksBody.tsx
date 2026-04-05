import FlashcardDeckCard from "@/app/course/[course_id]/flashcards/flashcard-deck";
import { getCachedFlashcardDecksForCourse } from "@/lib/server-route-cache";
import type { FlashcardDeck } from "@/utils/supabase/DatabaseTypes";
import * as Sentry from "@sentry/nextjs";
import { Badge, Box, Heading, SimpleGrid, Text, VStack } from "@chakra-ui/react";
export async function FlashcardsDecksBody({ course_id }: { course_id: string }) {
  const classId = Number(course_id);
  const { decks: flashcardDecks, error: fetchError } = await getCachedFlashcardDecksForCourse(classId);

  if (fetchError) {
    Sentry.captureException(new Error(fetchError));
    return (
      <Box p={8} borderRadius="xl" border="1px solid">
        <Text textAlign="center" fontSize="lg">
          Error loading flashcard decks. Please try again later.
        </Text>
      </Box>
    );
  }

  if (!flashcardDecks || flashcardDecks.length === 0) {
    return (
      <VStack align="center" justify="center" minH="400px" gap={6} borderRadius="2xl" p={12} border="2px dashed">
        <Box p={6} borderRadius="full" mb={2}>
          <Text fontSize="4xl">📚</Text>
        </Box>
        <VStack gap={3}>
          <Heading size="lg">No flashcard decks yet</Heading>
          <Text fontSize="lg" textAlign="center">
            Your instructor will create flashcard decks for you to practice with.
          </Text>
          <Text fontSize="md" textAlign="center">
            Check back later or contact your instructor if you think this is an error.
          </Text>
        </VStack>
      </VStack>
    );
  }

  return (
    <>
      <Box display="flex" justifyContent="center" mb={2}>
        <Badge variant="subtle" fontSize="sm" px={3} py={1} borderRadius="full">
          {flashcardDecks.length} deck{flashcardDecks.length !== 1 ? "s" : ""} available
        </Badge>
      </Box>
      <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4, xl: 5 }} gap={24} justifyItems="center" px={4}>
        {flashcardDecks.map((deck: FlashcardDeck) => (
          <FlashcardDeckCard key={deck.id} deck={deck} courseId={course_id} />
        ))}
      </SimpleGrid>
    </>
  );
}
