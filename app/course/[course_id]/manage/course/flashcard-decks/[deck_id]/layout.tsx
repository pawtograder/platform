"use client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Button, Flex, Heading, HStack, VStack } from "@chakra-ui/react";
import { useOne } from "@refinedev/core";
import NextLink from "next/link";
import { useParams, usePathname } from "next/navigation";
import React from "react";
import { FaHome, FaChartBar, FaUsers } from "react-icons/fa";

// Supabase types
type FlashcardDeckRow = Database["public"]["Tables"]["flashcard_decks"]["Row"];

/**
 * Links for the flashcard deck layout
 * @param courseId - The course id
 * @param deckId - The deck id
 * @returns The links
 */
const LinkItems = (courseId: string, deckId: string) => [
  { label: "Deck Home", href: `/course/${courseId}/manage/course/flashcard-decks/${deckId}`, icon: FaHome },
  {
    label: "Analytics",
    href: `/course/${courseId}/manage/course/flashcard-decks/${deckId}/analytics`,
    icon: FaChartBar
  },
  {
    label: "Student Analytics",
    href: `/course/${courseId}/manage/course/flashcard-decks/${deckId}/student-analytics`,
    icon: FaUsers
  }
];

/**
 * Layout for the flashcard deck
 * @param children - The children of the component
 * @returns The FlashcardDeckLayout component
 */
export default function FlashcardDeckLayout({ children }: { children: React.ReactNode }) {
  const { course_id, deck_id } = useParams();
  const { data: deck } = useOne<FlashcardDeckRow>({
    resource: "flashcard_decks",
    id: deck_id as string
  });
  const pathname = usePathname();

  return (
    <Flex pt={4}>
      <Box w="xs" pr={2} flex={0}>
        <VStack align="flex-start">
          {LinkItems(course_id as string, deck_id as string).map((item) => (
            <Button
              key={item.label}
              variant={pathname === item.href ? "solid" : "ghost"}
              w="100%"
              size="xs"
              pt="0"
              fontSize="sm"
              justifyContent="flex-start"
              asChild
            >
              <NextLink href={item.href} prefetch={true}>
                <HStack textAlign="left" w="100%" justify="flex-start">
                  {React.createElement(item.icon)}
                  {item.label}
                </HStack>
              </NextLink>
            </Button>
          ))}
        </VStack>
      </Box>
      <Box borderColor="border.muted" borderWidth="2px" borderRadius="md" p={4} flexGrow={1} minWidth="0">
        <Heading size="lg">Flashcard Deck: {deck ? deck.data?.name : "Loading..."}</Heading>
        <Box>{children}</Box>
      </Box>
    </Flex>
  );
}
