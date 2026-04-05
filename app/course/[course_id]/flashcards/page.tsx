import { AppNestedRouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { Box, Container, Heading, Text, VStack } from "@chakra-ui/react";
import { Suspense } from "react";
import { FlashcardsDecksBody } from "./FlashcardsDecksBody";

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
        <Suspense fallback={<AppNestedRouteLoadingSkeleton />}>
          <FlashcardsDecksBody course_id={course_id} />
        </Suspense>
      </VStack>
    </Container>
  );
}
