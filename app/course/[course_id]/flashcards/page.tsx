import { Box, Container, Heading, SimpleGrid, Skeleton, Text, VStack } from "@chakra-ui/react";
import { Suspense } from "react";
import { FlashcardsDecksBody } from "./FlashcardsDecksBody";

function FlashcardsDecksFallback() {
  return (
    <SimpleGrid columns={{ base: 1, sm: 2, md: 3 }} gap={6} px={4} py={2}>
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} height="140px" borderRadius="md" />
      ))}
    </SimpleGrid>
  );
}

type FlashcardsPageProps = {
  params: Promise<{ course_id: string }>;
};

export default async function FlashcardsPage({ params }: FlashcardsPageProps) {
  const { course_id } = await params;

  return (
    <Container py={8}>
      <VStack align="stretch" gap={8}>
        <Box textAlign="center" mb={4}>
          <Heading size="2xl" mb={4}>
            Flashcard Decks
          </Heading>
          <Text fontSize="lg" mx="auto">
            Practice and reinforce your learning with interactive flashcard decks
          </Text>
        </Box>
        <Suspense fallback={<FlashcardsDecksFallback />}>
          <FlashcardsDecksBody course_id={course_id} />
        </Suspense>
      </VStack>
    </Container>
  );
}
