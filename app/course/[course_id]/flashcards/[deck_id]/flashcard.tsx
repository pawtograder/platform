"use client";

import { Box, Card, VStack, Text, Badge } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { FaCheckCircle, FaTimes } from "react-icons/fa";
import Markdown from "@/components/ui/markdown";
import { Database } from "@/utils/supabase/SupabaseTypes";

type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];

type FlashcardProps = {
  /** The current flashcard being displayed */
  currentCard: FlashcardRow;
  /** All flashcards in the deck for numbering purposes */
  flashcards: FlashcardRow[];
  /** Available cards (not yet mastered) for numbering purposes */
  availableCards: FlashcardRow[];
  /** Whether the answer is currently shown */
  showAnswer: boolean;
  /** Callback to show the answer */
  onShowAnswer: () => void;
  /** Callback when user marks card as "Got It" */
  onGotIt: () => void;
  /** Callback when user marks card as "Keep Trying" */
  onKeepTrying: () => void;
};

/**
 * Individual flashcard display component showing prompt, answer, and action buttons.
 * Handles the display of a single flashcard with proper interaction flows.
 * Styled to match the flashcard deck cards with compact design and consistent dimensions.
 * Features a flipping animation that transitions between question and answer sides.
 * @param currentCard - The current flashcard being displayed
 * @param flashcards - All flashcards in the deck for numbering purposes
 * @param availableCards - Available cards (not yet mastered) for numbering purposes
 * @param showAnswer - Whether the answer is currently shown
 * @param onShowAnswer - Callback to show the answer
 * @param onGotIt - Callback when user marks card as "Got It"
 * @param onKeepTrying - Callback when user marks card as "Keep Trying"
 * @returns A flashcard component with a flipping animation that transitions between question and answer sides.
 */
export default function Flashcard({
  currentCard,
  flashcards,
  availableCards,
  showAnswer,
  onShowAnswer,
  onGotIt,
  onKeepTrying
}: FlashcardProps) {
  return (
    <Box height="49em" width="35em" mx="auto" position="relative" style={{ perspective: "1000px" }}>
      {/* Card Container with Flip Animation */}
      <Box
        position="relative"
        width="100%"
        height="100%"
        transition="transform 0.6s ease-in-out"
        transform={showAnswer ? "rotateY(180deg)" : "rotateY(0deg)"}
        style={{ transformStyle: "preserve-3d" }}
      >
        {/* Question Side (Front) */}
        <Card.Root
          variant="outline"
          p={6}
          borderRadius="lg"
          textAlign="center"
          height="100%"
          width="100%"
          position="absolute"
          top={0}
          left={0}
          transition="all 0.2s"
          _hover={{
            shadow: "md",
            transform: "translateY(-2px)"
          }}
          style={{
            backfaceVisibility: "hidden",
            transform: "rotateY(0deg)"
          }}
        >
          <Card.Header p={2}>
            <VStack gap={2}>
              <Badge variant="outline" fontSize="sm">
                Card {flashcards.length - availableCards.length + 1} of {flashcards.length}
              </Badge>
              <Text fontWeight="semibold" fontSize="md" lineHeight="1.2" textAlign="center">
                {currentCard.title}
              </Text>
            </VStack>
          </Card.Header>

          <Card.Body p={3} flex={1} display="flex" flexDirection="column" minHeight={0}>
            <VStack align="stretch" gap={4} height="100%">
              <Text fontSize="md" fontWeight="medium">
                Question:
              </Text>
              <Box
                flex={1}
                fontSize="lg"
                lineHeight="1.4"
                textAlign="left"
                display="flex"
                alignItems="flex-start"
                p={4}
                overflowWrap="break-word"
                wordBreak="break-word"
                overflowY="auto"
                maxHeight="100%"
              >
                <Box width="100%">
                  <Markdown>{currentCard.prompt}</Markdown>
                </Box>
              </Box>
            </VStack>
          </Card.Body>

          <Card.Footer p={3}>
            <Button onClick={onShowAnswer} size="sm" width="100%" fontSize="md">
              Show Answer
            </Button>
          </Card.Footer>
        </Card.Root>

        {/* Answer Side (Back) */}
        <Card.Root
          variant="outline"
          p={6}
          borderRadius="lg"
          textAlign="center"
          height="100%"
          width="100%"
          position="absolute"
          top={0}
          left={0}
          transition="all 0.2s"
          _hover={{
            shadow: "md",
            transform: "translateY(-2px)"
          }}
          style={{
            backfaceVisibility: "hidden",
            transform: "rotateY(180deg)"
          }}
        >
          <Card.Header p={2}>
            <VStack gap={2}>
              <Badge variant="outline" fontSize="sm">
                Card {flashcards.length - availableCards.length + 1} of {flashcards.length}
              </Badge>
              <Text fontWeight="semibold" fontSize="md" lineHeight="1.2" textAlign="center">
                {currentCard.title}
              </Text>
            </VStack>
          </Card.Header>

          <Card.Body p={3} flex={1} display="flex" flexDirection="column" minHeight={0}>
            <VStack align="stretch" gap={4} height="100%">
              <Text fontSize="md" fontWeight="medium">
                Answer:
              </Text>
              <Box
                flex={1}
                fontSize="lg"
                lineHeight="1.4"
                textAlign="left"
                display="flex"
                alignItems="flex-start"
                p={4}
                overflowWrap="break-word"
                wordBreak="break-word"
                overflowY="auto"
                maxHeight="100%"
              >
                <Box width="100%">
                  <Markdown>{currentCard.answer}</Markdown>
                </Box>
              </Box>
            </VStack>
          </Card.Body>

          <Card.Footer p={3}>
            <VStack gap={2} width="100%">
              <Button onClick={onGotIt} size="sm" colorPalette="green" width="100%" fontSize="md">
                <FaCheckCircle />
                Got It!
              </Button>
              <Button onClick={onKeepTrying} size="sm" colorPalette="red" variant="outline" width="100%" fontSize="md">
                <FaTimes />
                Keep Trying
              </Button>
            </VStack>
          </Card.Footer>
        </Card.Root>
      </Box>
    </Box>
  );
}
