import { Container, Heading, SimpleGrid, Text, VStack, Box, Badge } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/server";
import FlashcardDeckCard from "@/app/course/[course_id]/flashcards/flashcard-deck";
import type { FlashcardDeck } from "@/utils/supabase/DatabaseTypes";

/**
 * This type defines the props for the FlashcardsPage component.
 * @param params - The route parameters containing course_id
 */
type FlashcardsPageProps = {
  params: Promise<{ course_id: string }>;
};

/**
 * Page component for displaying all flashcard decks in a course.
 * Students can view and access available flashcard decks for practice.
 * @param params - The route parameters containing course_id
 * @returns The FlashcardsPage component
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
      <Container py={8}>
        <VStack align="stretch" gap={6}>
          <Heading size="xl" textAlign="center">
            Flashcard Decks
          </Heading>
          <Box p={8} borderRadius="xl" border="1px solid" data-visual-test-no-radius>
            <Text textAlign="center" fontSize="lg">
              Error loading flashcard decks. Please try again later.
            </Text>
          </Box>
        </VStack>
      </Container>
    );
  }

  return (
    <Container py={8}>
      <VStack align="stretch" gap={8}>
        {/* Header Section */}
        <Box textAlign="center" mb={4}>
          <Heading size="2xl" mb={4}>
            Flashcard Decks
          </Heading>
          <Text fontSize="lg" mx="auto">
            Practice and reinforce your learning with interactive flashcard decks
          </Text>
        </Box>

        {!flashcardDecks || flashcardDecks.length === 0 ? (
          <VStack
            align="center"
            justify="center"
            minH="400px"
            gap={6}
            borderRadius="2xl"
            p={12}
            border="2px dashed"
            data-visual-test-no-radius
          >
            <Box p={6} borderRadius="full" mb={2} data-visual-test-no-radius>
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
        ) : (
          <>
            {/* Deck count badge */}
            <Box display="flex" justifyContent="center" mb={2}>
              <Badge variant="subtle" fontSize="sm" px={3} py={1} borderRadius="full" data-visual-test-no-radius>
                {flashcardDecks.length} deck{flashcardDecks.length !== 1 ? "s" : ""} available
              </Badge>
            </Box>

            {/* Cards Grid */}
            <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4, xl: 5 }} gap={24} justifyItems="center" px={4}>
              {flashcardDecks.map((deck: FlashcardDeck) => (
                <FlashcardDeckCard key={deck.id} deck={deck} courseId={course_id} />
              ))}
            </SimpleGrid>
          </>
        )}
      </VStack>
    </Container>
  );
}
