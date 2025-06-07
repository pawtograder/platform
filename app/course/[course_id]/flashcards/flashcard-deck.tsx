"use client";

import { Card, Icon, Skeleton, Box } from "@chakra-ui/react";
import { GiCardRandom } from "react-icons/gi";
import Link from "next/link";
import type { FlashcardDeck } from "@/utils/supabase/DatabaseTypes";

/**
 * This type defines the props for the FlashcardDeckCard component.
 * @param deck - The flashcard deck data
 * @param courseId - The course ID for navigation
 */
type FlashcardDeckCardProps = {
  /** The flashcard deck data */
  deck: FlashcardDeck;
  /** The course ID for navigation */
  courseId: string;
};

/**
 * This component displays a skeleton for the FlashcardDeckCard component.
 * @returns A skeleton component for the FlashcardDeckCard
 */
export const FlashcardDeckCardSkeleton = () => {
  return (
    <Card.Root
      variant="outline"
      cursor="pointer"
      transition="all 0.3s ease-in-out"
      borderRadius="xl"
      overflow="hidden"
      height="336px"
      width="240px"
    >
      <Card.Body p={8}>
        <Box mb={6} display="flex" justifyContent="center">
          <Skeleton height="80px" width="80px" borderRadius="full" />
        </Box>
        <Skeleton height="24px" width="100%" mb={2} borderRadius="md" />
        <Skeleton height="16px" width="80%" borderRadius="md" />
      </Card.Body>
    </Card.Root>
  );
};

/**
 * Component for displaying a single flashcard deck as a clickable card
 * with an icon and deck name. Features hover effects and navigation.
 * @param deck - The flashcard deck data
 * @param courseId - The course ID for navigation
 * @returns The FlashcardDeckCard component
 */
export default function FlashcardDeckCard({ deck, courseId }: FlashcardDeckCardProps) {
  return (
    <Link href={`/course/${courseId}/flashcards/${deck.id}`} passHref>
      <Card.Root
        variant="outline"
        cursor="pointer"
        transition="all 0.3s ease-in-out"
        _hover={{
          shadow: "2xl",
          transform: "translateY(-8px) scale(1.02)"
        }}
        _active={{
          transform: "translateY(-2px) scale(1.01)"
        }}
        borderRadius="xl"
        overflow="hidden"
        height="336px"
        width="240px"
        borderWidth="1px"
        position="relative"
        role="group"
      >
        <Card.Header>
          <Card.Title fontWeight="semibold" fontSize="lg" textAlign="center" lineHeight="1.4">
            {deck.name}
          </Card.Title>
          <Card.Description fontSize="sm" textAlign="center">
            {deck.description}
          </Card.Description>
        </Card.Header>
        <Card.Body p={8} position="relative" zIndex={1}>
          {/* Icon container with background */}
          <Box mb={6} display="flex" justifyContent="center" alignItems="center" position="relative">
            <Box
              position="absolute"
              width="100px"
              height="100px"
              borderRadius="full"
              transition="all 0.3s ease-in-out"
              _groupHover={{
                transform: "scale(1.1)"
              }}
            />
            <Icon
              aria-label={`Open ${deck.name} flashcard deck`}
              transition="all 0.3s ease-in-out"
              _groupHover={{
                transform: "scale(1.1)"
              }}
              position="relative"
              zIndex={1}
            >
              <GiCardRandom size={128} />
            </Icon>
          </Box>
        </Card.Body>
      </Card.Root>
    </Link>
  );
}
