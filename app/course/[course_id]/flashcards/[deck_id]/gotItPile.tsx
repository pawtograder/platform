"use client";

import { Database } from "@/utils/supabase/SupabaseTypes";
import { Badge, Box, Card, HStack, IconButton, SimpleGrid, Text, useBreakpointValue } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { FaUndo } from "react-icons/fa";

// Supabase types
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];

/**
 * This type defines the props for the GotItPile component.
 * @param gotItCards - Array of flashcards that have been mastered
 * @param onReturnCard - Callback to return a card back to the practice pile
 */
type GotItPileProps = {
  /** Array of flashcards that have been mastered */
  gotItCards: FlashcardRow[];
  /** Callback to return a card back to the practice pile */
  onReturnCard: (cardId: number) => void;
};

/**
 * Component displaying the collection of mastered flashcards with options to return them to practice.
 * Shows a grid of card-shaped entries that the user has marked as "Got It" with return functionality.
 * @param gotItCards - Array of flashcards that have been mastered
 * @param onReturnCard - Callback to return a card back to the practice pile
 * @returns A component displaying the collection of mastered flashcards with options to return them to practice.
 */
export default function GotItPile({ gotItCards, onReturnCard }: GotItPileProps) {
  const [expanded, setExpanded] = useState(false);
  // Responsive number of cards per row
  const cardsPerRow = useBreakpointValue({ base: 2, sm: 3, md: 4, lg: 6 }) ?? 2;
  const showToggle = gotItCards.length > cardsPerRow;
  const visibleCards = useMemo(
    () => (expanded ? gotItCards : gotItCards.slice(0, cardsPerRow)),
    [expanded, gotItCards, cardsPerRow]
  );

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
        <SimpleGrid minChildWidth="140px" gap={4}>
          {visibleCards.map((card, idx) => {
            // Determine if this is the last visible card in collapsed mode and there are more cards
            const isLastVisible = !expanded && showToggle && idx === visibleCards.length - 1;
            const hiddenCount = gotItCards.length - cardsPerRow;
            return (
              <Box key={card.id} position="relative" w="full" h="full">
                {/* Stacked cards effect */}
                {isLastVisible && (
                  <>
                    <Box
                      position="absolute"
                      bottom={-2}
                      right={-2}
                      left={2}
                      height="90%"
                      bg="bg.emphasized"
                      borderRadius="lg"
                      zIndex={0}
                      boxShadow="md"
                      opacity={0.5}
                    />
                  </>
                )}
                <Card.Root
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
                  w="full"
                  borderWidth="1px"
                  position="relative"
                  role="group"
                  zIndex={1}
                  onClick={isLastVisible ? () => setExpanded(true) : undefined}
                  tabIndex={isLastVisible ? 0 : undefined}
                  aria-label={isLastVisible ? `Show ${hiddenCount} more mastered cards` : undefined}
                >
                  {/* +X more badge */}
                  {isLastVisible && (
                    <Badge
                      position="absolute"
                      top={2}
                      right={2}
                      zIndex={2}
                      colorScheme="blue"
                      borderRadius="full"
                      px={2}
                      py={0.5}
                      fontSize="xs"
                    >
                      +{hiddenCount} more
                    </Badge>
                  )}
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
              </Box>
            );
          })}
        </SimpleGrid>
        {showToggle && (
          <Box display="flex" justifyContent="center" mt={2}>
            <IconButton
              size="sm"
              variant="ghost"
              onClick={() => setExpanded((prev) => !prev)}
              aria-label={expanded ? "Show less mastered cards" : "Show more mastered cards"}
              borderRadius="md"
            >
              {expanded ? "Show Less" : "Show More"}
            </IconButton>
          </Box>
        )}
      </Card.Body>
    </Card.Root>
  );
}
