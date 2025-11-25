"use client";

import Markdown from "@/components/ui/markdown";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Button, Card, HStack, Text, Tooltip, VStack } from "@chakra-ui/react";
import { useRef } from "react";
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
  const previousCard = useRef<FlashcardRow | null>(null);
  if (showAnswer) {
    previousCard.current = currentCard;
  }

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
        <Tooltip.Root disabled={showAnswer}>
          <Tooltip.Trigger asChild>
            <Card.Root
              variant="outline"
              p={{ base: 4, md: 6 }}
              borderRadius="2xl"
              textAlign="center"
              height="100%"
              width="100%"
              position="absolute"
              top={0}
              left={0}
              transition="all 0.3s ease-in-out"
              _hover={{
                shadow: "2xl",
                transform: "translateY(-8px) scale(1.1)"
              }}
              _active={{
                transform: "translateY(-2px) scale(1.1)"
              }}
              style={{
                backfaceVisibility: "hidden",
                transform: "rotateY(0deg)",
                zIndex: showAnswer ? 1 : 2,
                pointerEvents: showAnswer ? "none" : "auto"
              }}
              onClick={onShowAnswer}
              cursor={showAnswer ? "default" : "pointer"}
            >
              <Card.Header p={0}>
                <Text fontWeight="semibold" fontSize={{ base: "xl", md: "4xl" }} lineHeight="1.2" textAlign="center">
                  Question: {currentCard.title}
                </Text>
              </Card.Header>

              <Card.Body p={3} flex={1} display="flex" flexDirection="column" minHeight={0}>
                <VStack align="stretch" gap={4} height="100%">
                  <Box
                    flex={1}
                    fontSize={{ base: "md", md: "2xl" }}
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
                    <Box width="100%" fontSize={{ base: "md", md: "2xl" }}>
                      <Markdown>{currentCard.prompt}</Markdown>
                    </Box>
                  </Box>
                </VStack>
              </Card.Body>
            </Card.Root>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <Tooltip.Arrow />
            Click to show answer
          </Tooltip.Content>
        </Tooltip.Root>

        {/* Answer Side (Back) */}
        <Card.Root
          variant="outline"
          p={{ base: 4, md: 6 }}
          borderRadius="2xl"
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
          <Card.Header p={0} pr={{ base: "6rem", md: "9rem" }} position="relative">
            <Text
              fontWeight="semibold"
              fontSize={{ base: "xl", md: "4xl" }}
              lineHeight="1.2"
              textAlign="center"
              w="full"
              px={2}
              wordBreak="break-word"
            >
              Answer: {previousCard.current?.title}
            </Text>
            <Button
              onClick={onBackToQuestion}
              size={{ base: "sm", md: "md" }}
              variant="outline"
              aria-label="Back to question"
              position="absolute"
              right={0}
              top="50%"
              transform="translateY(-50%)"
            >
              <MdReplay />
              <Box as="span" display={{ base: "none", md: "inline" }} ml={2}>
                Back to Question
              </Box>
            </Button>
          </Card.Header>

          <Card.Body p={3} flex={1} display="flex" flexDirection="column" minHeight={0}>
            <VStack align="stretch" gap={4} height="100%">
              <Box
                flex={1}
                fontSize={{ base: "md", md: "2xl" }}
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
                <Box width="100%" fontSize={{ base: "md", md: "2xl" }}>
                  <Markdown>{previousCard.current?.answer}</Markdown>
                </Box>
              </Box>
            </VStack>
          </Card.Body>

          <Card.Footer p={3}>
            <HStack gap={{ base: 2, md: 4 }} width="100%" display="flex">
              <Button onClick={onKeepTrying} size={{ base: "sm", md: "lg" }} colorPalette="red" flex={1}>
                <FaTimes />
                Keep Trying
              </Button>
              <Button onClick={onGotIt} size={{ base: "sm", md: "lg" }} colorPalette="green" flex={1}>
                <FaCheckCircle />
                Got It!
              </Button>
            </HStack>
          </Card.Footer>
        </Card.Root>
      </Box>
    </Box>
  );
}
