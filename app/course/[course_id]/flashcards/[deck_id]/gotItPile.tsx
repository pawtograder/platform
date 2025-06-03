"use client";

import { Card, Text, IconButton, SimpleGrid, Box, HStack, Badge } from "@chakra-ui/react";
import { FaUndo } from "react-icons/fa";
import { Database } from "@/utils/supabase/SupabaseTypes";

type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];

type GotItPileProps = {
  /** Array of flashcards that have been mastered */
  gotItCards: FlashcardRow[];
  /** Callback to return a card back to the practice pile */
  onReturnCard: (cardId: number) => void;
};

/**
 * Component displaying the collection of mastered flashcards with options to return them to practice.
 * Shows a grid of card-shaped entries that the user has marked as "Got It" with return functionality.
 */
export default function GotItPile({ gotItCards, onReturnCard }: GotItPileProps) {
  if (gotItCards.length === 0) {
    return null;
  }

  return (
    <Card.Root variant="outline">
      <Card.Header>
        <HStack justifyContent="space-between" alignItems="center">
          <Card.Title>Cards You&apos;ve Mastered</Card.Title>
          <Badge variant="subtle" colorPalette="green" fontSize="sm" px={3} py={1} borderRadius="full">
            {gotItCards.length} mastered
          </Badge>
        </HStack>
      </Card.Header>
      <Card.Body>
        <SimpleGrid columns={{ base: 2, sm: 3, md: 4, lg: 6 }} gap={32}>
          {gotItCards.map((card) => (
            <Card.Root
              key={card.id}
              variant="outline"
              size="sm"
              cursor="pointer"
              transition="all 0.3s ease-in-out"
              _hover={{
                shadow: "lg",
                transform: "translateY(-4px) scale(1.02)"
              }}
              _active={{
                transform: "translateY(-1px) scale(1.01)"
              }}
              borderRadius="lg"
              overflow="hidden"
              height="160px"
              width="140px"
              borderWidth="1px"
              position="relative"
              role="group"
            >
              {/* Success gradient overlay */}
              <Box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                opacity={0}
                transition="opacity 0.3s ease-in-out"
                _groupHover={{ opacity: 1 }}
                pointerEvents="none"
              />

              <Card.Body p={3} position="relative" zIndex={1} display="flex" flexDirection="column" height="100%">
                {/* Success indicator */}
                <Box mb={2} display="flex" justifyContent="center" alignItems="center" position="relative">
                  <Box
                    position="absolute"
                    width="32px"
                    height="32px"
                    borderRadius="full"
                    transition="all 0.3s ease-in-out"
                    _groupHover={{
                      transform: "scale(1.1)"
                    }}
                  />
                  <Text fontSize="lg" transition="all 0.3s ease-in-out" position="relative" zIndex={1}>
                    ✓
                  </Text>
                </Box>

                {/* Card title */}
                <Box flex={1} display="flex" alignItems="center" justifyContent="center" mb={2}>
                  <Text
                    fontWeight="medium"
                    fontSize="xs"
                    textAlign="center"
                    lineHeight="1.3"
                    transition="color 0.3s ease-in-out"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    css={{
                      display: "-webkit-box",
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: "vertical"
                    }}
                  >
                    {card.title}
                  </Text>
                </Box>

                {/* Return button */}
                <Box display="flex" justifyContent="center">
                  <IconButton
                    size="xs"
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReturnCard(card.id);
                    }}
                    aria-label={`Return "${card.title}" to practice pile`}
                    borderRadius="md"
                    transition="all 0.3s ease-in-out"
                  >
                    <FaUndo />
                  </IconButton>
                </Box>
              </Card.Body>

              {/* Subtle success accent */}
              <Box
                position="absolute"
                bottom={0}
                left={0}
                right={0}
                height="2px"
                opacity={0.7}
                transition="opacity 0.3s ease-in-out"
                _groupHover={{ opacity: 1 }}
              />
            </Card.Root>
          ))}
        </SimpleGrid>
      </Card.Body>
    </Card.Root>
  );
}
