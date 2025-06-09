"use client";

import { Button } from "@/components/ui/button";
import Markdown from "@/components/ui/markdown";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Card, HStack, Text, VStack } from "@chakra-ui/react";
import { FaCheckCircle, FaTimes } from "react-icons/fa";
import { MdReplay } from "react-icons/md";

// Supabase types
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];

/**
 * This type defines the props for the Flashcard component.
 * @param currentCard - The current flashcard being displayed
 * @param availableCards - Available cards (current queue) for numbering purposes
 * @param showAnswer - Whether the answer is currently shown
 * @param onShowAnswer - Callback to show the answer
 * @param onGotIt - Callback when user marks card as "Got It"
 * @param onKeepTrying - Callback when user marks card as "Keep Trying"
 */
type FlashcardProps = {
  /** The current flashcard being displayed */
  currentCard: FlashcardRow;
  /** Available cards (current queue) for numbering purposes */
  availableCards: FlashcardRow[];
  /** Whether the answer is currently shown */
  showAnswer: boolean;
  /** Callback to show the answer */
  onShowAnswer: () => void;
  /** Callback when user marks card as "Got It" */
  onGotIt: () => void;
  /** Callback when user marks card as "Keep Trying" */
  onKeepTrying: () => void;
  /** Callback when user wants to go back to the question */
  onBackToQuestion: () => void;
};

/**
 * Individual flashcard display component showing prompt, answer, and action buttons.
 * Handles the display of a single flashcard with proper interaction flows.
 * Styled to match the flashcard deck cards with compact design and consistent dimensions.
 * Features a flipping animation that transitions between question and answer sides.
 * @param currentCard - The current flashcard being displayed
 * @param availableCards - Available cards (current queue) for numbering purposes
 * @param showAnswer - Whether the answer is currently shown
 * @param onShowAnswer - Callback to show the answer
 * @param onGotIt - Callback when user marks card as "Got It"
 * @param onKeepTrying - Callback when user marks card as "Keep Trying"
 * @returns A flashcard component with a flipping animation that transitions between question and answer sides.
 */
export default function Flashcard({
  currentCard,
  showAnswer,
  onShowAnswer,
  onGotIt,
  onBackToQuestion,
  onKeepTrying
}: FlashcardProps) {
  return (
    <Box height="100%" maxW="4xl" mx="auto" style={{ perspective: "1000px" }}>
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
            transform: "rotateY(0deg)",
            zIndex: showAnswer ? 1 : 2,
            pointerEvents: showAnswer ? "none" : "auto"
          }}
        >
          <Card.Header p={0}>
            <Text fontWeight="semibold" fontSize="md" lineHeight="1.2" textAlign="center">
              Question: {currentCard.title}
            </Text>
          </Card.Header>

          <Card.Body p={3} flex={1} display="flex" flexDirection="column" minHeight={0}>
            <VStack align="stretch" gap={4} height="100%">
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
                <Box width="100%" fontSize="md">
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
          borderColor="border.emphasized"
          bg="bg.subtle"
          top={0}
          left={0}
          transition="all 0.2s"
          _hover={{
            shadow: "md",
            transform: "translateY(-2px)"
          }}
          style={{
            backfaceVisibility: "hidden",
            transform: "rotateY(180deg)",
            zIndex: showAnswer ? 2 : 1,
            pointerEvents: showAnswer ? "auto" : "none"
          }}
        >
          <Card.Header p={0}>
            <Text fontWeight="semibold" fontSize="md" lineHeight="1.2" textAlign="center">
              Answer: {currentCard.title}
            </Text>
          </Card.Header>

          <Card.Body p={3} flex={1} display="flex" flexDirection="column" minHeight={0}>
            <VStack align="stretch" gap={4} height="100%">
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
                <Box width="100%" fontSize="md">
                  <Markdown>{currentCard.answer}</Markdown>
                </Box>
              </Box>
            </VStack>
          </Card.Body>

          <Card.Footer p={3}>
            <HStack gap={1} width="100%" display="flex">
              <Button onClick={onGotIt} size="sm" colorPalette="green" fontSize="md" flex={1}>
                <FaCheckCircle />
                Got It!
              </Button>
              <Button onClick={onBackToQuestion} size="sm" colorPalette="blue" variant="outline" fontSize="md" flex={0}>
                <MdReplay />
              </Button>
              <Button onClick={onKeepTrying} size="sm" colorPalette="red" variant="outline" fontSize="md" flex={1}>
                <FaTimes />
                Keep Trying
              </Button>
            </HStack>
          </Card.Footer>
        </Card.Root>
      </Box>
    </Box>
  );
}
