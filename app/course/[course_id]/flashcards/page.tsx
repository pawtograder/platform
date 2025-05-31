import { Container, Heading, SimpleGrid, Text, VStack } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/server";
import FlashcardDeckCard from "@/components/ui/flashcard-deck";
import type { FlashcardDeck } from "@/utils/supabase/DatabaseTypes";

/**
 * Props for the FlashcardsPage component
 */
type FlashcardsPageProps = {
  params: Promise<{ course_id: string }>;
};

/**
 * Page component for displaying all flashcard decks in a course.
 * Students can view and access available flashcard decks for practice.
 *
 * @param params - The route parameters containing course_id
 */
export default async function FlashcardsPage({ params }: FlashcardsPageProps) {
  const { course_id } = await params;

  const client = await createClient();

  // Fetch flashcard decks for the current course
  const { data: flashcardDecks, error } = await client
    .from("flashcard_decks")
    .select("*")
    .eq("class_id", Number(course_id))
    .is("deleted_at", null) // Only show non-deleted decks
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <Container>
        <VStack align="stretch" gap={6}>
          <Heading size="lg" mb={4}>
            Flashcard Decks
          </Heading>
          <Text color="red.500">Error loading flashcard decks. Please try again later.</Text>
        </VStack>
      </Container>
    );
  }

  return (
    <Container maxW="6xl">
      <VStack align="stretch" gap={6}>
        <Heading size="lg" mb={4} m={2} textAlign="center">
          Flashcard Decks
        </Heading>

        {!flashcardDecks || flashcardDecks.length === 0 ? (
          <VStack align="center" justify="center" minH="200px" gap={4}>
            <Text fontSize="lg" color="gray.600" textAlign="center">
              No flashcard decks available yet.
            </Text>
            <Text fontSize="md" color="gray.500" textAlign="center">
              Your instructor will create flashcard decks for you to practice with.
            </Text>
          </VStack>
        ) : (
          <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4, xl: 5 }} gap={6} justifyItems="center">
            {flashcardDecks.map((deck: FlashcardDeck) => (
              <FlashcardDeckCard key={deck.id} deck={deck} courseId={course_id} />
            ))}
          </SimpleGrid>
        )}
      </VStack>
    </Container>
  );
}
