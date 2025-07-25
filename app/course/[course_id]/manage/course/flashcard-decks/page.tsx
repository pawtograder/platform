"use client";

import { useState } from "react";
import { VStack, HStack, Heading, Text } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { FaChartBar, FaPlus } from "react-icons/fa";
import { useParams } from "next/navigation";
import useModalManager from "@/hooks/useModalManager";
import FlashCardDecksTable from "./flashCardDecksTable";
import CreateDeckModal from "./createDeckModal";
import { Toaster } from "@/components/ui/toaster";
import Link from "@/components/ui/link";

/**
 * This component displays the flashcard decks page.
 * It allows the user to create a new flashcard deck and view the analytics for a flashcard deck.
 * @returns The flashcard decks page
 */
export default function FlashcardDecksPage() {
  const params = useParams();
  const course_id = params.course_id as string;
  const [refreshKey, setRefreshKey] = useState(0);

  // Modal management
  const { isOpen: isCreateModalOpen, openModal: openCreateModal, closeModal: closeCreateModal } = useModalManager();

  const handleCreateDeck = () => {
    openCreateModal();
  };

  const handleDeckCreated = () => {
    // Trigger a refresh of the table
    setRefreshKey((prev) => prev + 1);
  };

  const handleDeckDeleted = () => {
    // Trigger a refresh of the table
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <>
      <Toaster />
      <VStack align="stretch" w="100%" gap={6} p={6}>
        {/* Header Section */}
        <VStack align="stretch" gap={4}>
          <HStack justifyContent="space-between" alignItems="center">
            <VStack align="start" gap={2}>
              <Heading size="lg">Flashcard Decks</Heading>
              <Text color="gray.600">
                Create and manage flashcard decks for student practice. Students can use these decks to study course
                material.
              </Text>
            </VStack>

            <HStack>
              <Button onClick={handleCreateDeck}>
                <FaPlus style={{ marginRight: "8px" }} />
                Create New Deck
              </Button>
              <Link href={`/course/${course_id}/manage/course/flashcard-decks/analytics`}>
                <Button variant="outline">
                  <FaChartBar style={{ marginRight: "8px" }} />
                  View Analytics
                </Button>
              </Link>
            </HStack>
          </HStack>
        </VStack>

        {/* Table Section */}
        <VStack align="stretch" w="100%">
          <FlashCardDecksTable key={refreshKey} courseId={course_id} onDeckDeleted={handleDeckDeleted} />
        </VStack>

        {/* Create Deck Modal */}
        <CreateDeckModal isOpen={isCreateModalOpen} onClose={closeCreateModal} onSuccess={handleDeckCreated} />
      </VStack>
    </>
  );
}
