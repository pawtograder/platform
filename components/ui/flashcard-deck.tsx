"use client";

import { Text, Card, Icon, Skeleton } from "@chakra-ui/react";
import { GiCardRandom } from "react-icons/gi";
import Link from "next/link";
import type { FlashcardDeck } from "@/utils/supabase/DatabaseTypes";

/**
 * Props for the FlashcardDeckCard component
 */
type FlashcardDeckCardProps = {
  /** The flashcard deck data */
  deck: FlashcardDeck;
  /** The course ID for navigation */
  courseId: string;
};

export const FlashcardDeckCardSkeleton = () => {
  return (
    <Card.Root
      variant="outline"
      p={6}
      cursor="pointer"
      transition="all 0.2s"
      _hover={{ shadow: "md", transform: "translateY(-5px)" }}
      _active={{ transform: "translateY(0px)" }}
      borderRadius="lg"
      textAlign="center"
      height="14em"
      width="10em"
    >
      <Card.Body>
        <Skeleton height="100px" width="100%" />
        <Skeleton height="100px" width="100%" />
      </Card.Body>
      <Card.Footer>
        <Skeleton height="100px" width="100%" />
      </Card.Footer>
    </Card.Root>
  );
};

/**
 * Component for displaying a single flashcard deck as a clickable card
 * with an icon and deck name. Features hover effects and navigation.
 *
 * @param deck - The flashcard deck data
 * @param courseId - The course ID for navigation
 */
export default function FlashcardDeckCard({ deck, courseId }: FlashcardDeckCardProps) {
  return (
    <Link href={`/course/${courseId}/flashcards/${deck.id}`} passHref>
      <Card.Root
        variant="outline"
        p={6}
        cursor="pointer"
        transition="all 0.2s"
        _hover={{
          shadow: "md",
          transform: "translateY(-5px)"
        }}
        _active={{
          transform: "translateY(0px)"
        }}
        borderRadius="lg"
        textAlign="center"
        height="14em"
        width="10em"
      >
        <Card.Body>
          <Icon aria-label={`Open ${deck.name} flashcard deck`} alignSelf="center">
            <GiCardRandom size={64} />
          </Icon>
        </Card.Body>
        <Card.Footer>
          <Text
            fontWeight="medium"
            fontSize="sm"
            textAlign="center"
            lineHeight="1.3"
            overflow="hidden"
            textOverflow="ellipsis"
            WebkitLineClamp={2}
          >
            {deck.name}
          </Text>
        </Card.Footer>
      </Card.Root>
    </Link>
  );
}
