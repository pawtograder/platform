"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import Markdown from "@/components/ui/markdown";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster, Toaster } from "@/components/ui/toaster";
import useModalManager from "@/hooks/useModalManager";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Badge, Box, Heading, HStack, IconButton, Spinner, Text, VStack } from "@chakra-ui/react";
import { useDelete, useList, useOne } from "@refinedev/core";
import { format } from "date-fns";
import { useParams, useRouter } from "next/navigation";
import { FaEdit, FaPlus, FaTrash } from "react-icons/fa";
import AddFlashCardModal from "./addFlashCardModal";
import EditDeckModal from "./editDeckModal";
import EditFlashCardModal from "./editFlashCardModal";

// Supabase types
type FlashcardDeckRow = Database["public"]["Tables"]["flashcard_decks"]["Row"];
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];

/**
 * This component displays the flashcard deck page.
 * It allows the user to add, edit, and delete flashcards in a deck.
 * It also displays the analytics for a flashcard deck.
 * @returns The flashcard deck page
 */
export default function FlashcardDeckPage() {
  const params = useParams();
  const router = useRouter();
  const deck_id = params.deck_id as string;

  // Modal management for adding flashcards
  const { isOpen: isAddCardModalOpen, openModal: openAddCardModal, closeModal: closeAddCardModal } = useModalManager();

  // Modal management for editing flashcards
  const {
    isOpen: isEditCardModalOpen,
    modalData: editingCardId,
    openModal: openEditCardModal,
    closeModal: closeEditCardModal
  } = useModalManager<number>();

  // Modal management for editing deck
  const {
    isOpen: isEditDeckModalOpen,
    openModal: openEditDeckModal,
    closeModal: closeEditDeckModal
  } = useModalManager();

  // Fetch deck data
  const {
    data: deckData,
    isLoading: isDeckLoading,
    refetch: refetchDeck
  } = useOne<FlashcardDeckRow>({
    resource: "flashcard_decks",
    id: deck_id,
    queryOptions: {
      enabled: !!deck_id
    }
  });

  // Fetch flashcards in this deck
  const {
    data: flashcardsData,
    isLoading: isFlashcardsLoading,
    refetch: refetchFlashcards
  } = useList<FlashcardRow>({
    resource: "flashcards",
    filters: [
      {
        field: "deck_id",
        operator: "eq",
        value: deck_id
      },
      {
        field: "deleted_at",
        operator: "null",
        value: null
      }
    ],
    sorters: [
      {
        field: "order",
        order: "asc"
      },
      {
        field: "created_at",
        order: "asc"
      }
    ],
    pagination: {
      pageSize: 1000
    },
    queryOptions: {
      enabled: !!deck_id
    }
  });

  // Delete flashcard mutation
  const { mutate: deleteFlashcard } = useDelete();

  const deck = deckData?.data;
  const flashcards = flashcardsData?.data || [];

  const handleFlashcardAdded = () => {
    refetchFlashcards();
  };

  const handleFlashcardUpdated = () => {
    refetchFlashcards();
  };

  const handleDeckUpdated = () => {
    refetchDeck();
    refetchFlashcards();
  };

  const handleDeleteFlashcard = (cardId: number) => {
    deleteFlashcard(
      {
        resource: "flashcards",
        id: cardId
      },
      {
        onSuccess: () => {
          toaster.create({
            title: "Success",
            description: "Flashcard deleted successfully",
            type: "success"
          });
          refetchFlashcards();
        },
        onError: (error) => {
          toaster.create({
            title: "Error",
            description: "Failed to delete flashcard: " + error.message,
            type: "error"
          });
        }
      }
    );
  };

  if (isDeckLoading) {
    return (
      <VStack align="center" justify="center" h="200px">
        <Spinner size="lg" />
        <Text>Loading deck...</Text>
      </VStack>
    );
  }

  if (!deck) {
    return (
      <VStack align="center" justify="center" h="200px">
        <Text>Deck not found</Text>
        <Button onClick={() => router.back()}>Go Back</Button>
      </VStack>
    );
  }

  return (
    <VStack align="stretch" w="100%" gap={8} p={6} mx="auto">
      {/* Header Section */}
      <HStack justifyContent="space-between" alignItems="flex-start">
        <HStack gap={4} align="flex-start">
          <VStack align="start" gap={2}>
            <HStack gap={3} align="center">
              <Heading size="md">Edit Flashcard Deck</Heading>
              <Badge variant="subtle" px={2} py={1}>
                {isFlashcardsLoading ? (
                  <Spinner />
                ) : (
                  `${flashcards.length} ${flashcards.length === 1 ? "card" : "cards"}`
                )}
              </Badge>
            </HStack>
            <Text fontSize="sm">
              Created {format(new Date(deck.created_at), "MMM d, yyyy 'at' h:mm a")}
              {deck.updated_at && deck.updated_at !== deck.created_at && (
                <> • Updated {format(new Date(deck.updated_at), "MMM d, yyyy 'at' h:mm a")}</>
              )}
            </Text>
          </VStack>
        </HStack>

        <HStack gap={3}>
          <Button onClick={() => openEditDeckModal()} variant="outline" size="sm">
            <FaEdit />
            Edit Deck (YAML)
          </Button>
        </HStack>
      </HStack>

      {/* Deck Details Section */}
      <Box p={6} rounded="xl" border="1px" shadow="sm">
        <VStack align="stretch" gap={6}>
          <Field label="Deck Name">
            <Text fontSize="md" fontWeight="medium">
              {deck.name}
            </Text>
          </Field>

          <Field label="Description">
            <Markdown>{deck.description || "No description provided"}</Markdown>
          </Field>
        </VStack>
      </Box>

      {/* Flashcards Section */}
      <VStack align="stretch" gap={6}>
        <HStack justifyContent="space-between" alignItems="center">
          <HStack alignItems="center">
            <Heading size="lg">Flashcards</Heading>
            <Badge variant="subtle" px={2} py={1}>
              {flashcards.length} {flashcards.length === 1 ? "card" : "cards"}
            </Badge>
          </HStack>
          <Button onClick={() => openAddCardModal()} size="sm">
            <FaPlus />
            Add Flashcard
          </Button>
        </HStack>

        {isFlashcardsLoading ? (
          <VStack align="center" justify="center" h="120px">
            <Spinner size="lg" />
            <Text>Loading flashcards...</Text>
          </VStack>
        ) : flashcards.length === 0 ? (
          <Box p={8} rounded="xl" border="1px" textAlign="center">
            <Text mb={4} fontSize="md">
              No flashcards in this deck yet
            </Text>
            <Button onClick={() => openAddCardModal()} variant="solid">
              <FaPlus />
              Add Your First Flashcard
            </Button>
          </Box>
        ) : (
          <VStack align="stretch" gap={4}>
            {flashcards.map((card, index) => (
              <Box
                key={card.id}
                p={5}
                rounded="lg"
                border="1px"
                shadow="sm"
                _hover={{ shadow: "md" }}
                transition="all 0.2s"
              >
                <HStack justifyContent="space-between" alignItems="flex-start" gap={4}>
                  <VStack align="start" gap={3} flex={1}>
                    <HStack gap={3} align="center">
                      <Badge variant="outline" fontSize="xs">
                        #{index + 1}
                      </Badge>
                      <Text fontWeight="semibold" fontSize="md">
                        {card.title}
                      </Text>
                    </HStack>

                    <Box w="100%">
                      <Text fontSize="sm" fontWeight="medium" mb={1}>
                        Prompt:
                      </Text>
                      <Box fontSize="sm" lineHeight="1.5">
                        <Markdown>{card.prompt}</Markdown>
                      </Box>
                    </Box>

                    <Box w="100%">
                      <Text fontSize="sm" fontWeight="medium" mb={1}>
                        Answer:
                      </Text>
                      <Box fontSize="sm" lineHeight="1.5">
                        <Markdown>{card.answer}</Markdown>
                      </Box>
                    </Box>
                  </VStack>

                  <HStack gap={2} flexShrink={0}>
                    <Button size="sm" variant="outline" onClick={() => openEditCardModal(card.id)}>
                      <FaEdit />
                      Edit
                    </Button>
                    <PopConfirm
                      triggerLabel="Delete flashcard"
                      trigger={
                        <IconButton
                          size="sm"
                          variant="outline"
                          colorPalette="red"
                          aria-label={`Delete flashcard: ${card.title}`}
                        >
                          <FaTrash />
                        </IconButton>
                      }
                      confirmHeader="Delete Flashcard"
                      confirmText="Are you sure you want to delete this flashcard? This action cannot be undone."
                      onConfirm={() => handleDeleteFlashcard(card.id)}
                      onCancel={() => {}}
                    />
                  </HStack>
                </HStack>
              </Box>
            ))}
          </VStack>
        )}
      </VStack>

      {/* Add Flashcard Modal */}
      <AddFlashCardModal
        isOpen={isAddCardModalOpen}
        onClose={closeAddCardModal}
        deckId={deck_id}
        onSuccess={handleFlashcardAdded}
      />

      {/* Edit Flashcard Modal */}
      {editingCardId && (
        <EditFlashCardModal
          isOpen={isEditCardModalOpen}
          onClose={closeEditCardModal}
          flashcardId={editingCardId}
          onSuccess={handleFlashcardUpdated}
        />
      )}

      {/* Edit Deck Modal */}
      <EditDeckModal
        isOpen={isEditDeckModalOpen}
        onClose={closeEditDeckModal}
        deckId={deck_id}
        onSuccess={handleDeckUpdated}
      />

      <Toaster />
    </VStack>
  );
}
