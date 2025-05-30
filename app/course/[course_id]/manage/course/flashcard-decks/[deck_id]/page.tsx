"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { VStack, HStack, Heading, Text, Box, IconButton, Spinner, Badge, Textarea } from "@chakra-ui/react";
import { useForm } from "react-hook-form";
import { useOne, useUpdate, useList, useDelete } from "@refinedev/core";
import { FaEdit, FaSave, FaTimes, FaPlus, FaTrash, FaArrowLeft } from "react-icons/fa";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PopConfirm } from "@/components/ui/popconfirm";
import Link from "@/components/ui/link";
import { toaster } from "@/components/ui/toaster";
import useModalManager from "@/hooks/useModalManager";
import { Database } from "@/utils/supabase/SupabaseTypes";
import AddFlashCardModal from "./addFlashCardModal";

// Type definitions
type FlashcardDeckRow = Database["public"]["Tables"]["flashcard_decks"]["Row"];
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];
type FlashcardDeckUpdate = Database["public"]["Tables"]["flashcard_decks"]["Update"];

interface FlashcardDeckFormData {
  name: string;
  description?: string;
}

export default function FlashcardDeckPage() {
  const params = useParams();
  const router = useRouter();
  const course_id = params.course_id as string;
  const deck_id = params.deck_id as string;

  const [isEditing, setIsEditing] = useState(false);

  // Modal management for adding flashcards
  const { isOpen: isAddCardModalOpen, openModal: openAddCardModal, closeModal: closeAddCardModal } = useModalManager();

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
    queryOptions: {
      enabled: !!deck_id
    }
  });

  // Update deck mutation
  const { mutate: updateDeck, isLoading: isUpdating } = useUpdate();

  // Delete flashcard mutation
  const { mutate: deleteFlashcard } = useDelete();

  // Form for editing deck details
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty }
  } = useForm<FlashcardDeckFormData>();

  const deck = deckData?.data;
  const flashcards = flashcardsData?.data || [];

  // Reset form when deck data changes or editing mode changes
  useEffect(() => {
    if (deck && isEditing) {
      reset({
        name: deck.name,
        description: deck.description || ""
      });
    }
  }, [deck, isEditing, reset]);

  const handleEdit = () => {
    setIsEditing(true);
  };

  const handleCancel = () => {
    setIsEditing(false);
    reset();
  };

  const handleSave = (data: FlashcardDeckFormData) => {
    if (!deck) return;

    const updateData: FlashcardDeckUpdate = {
      name: data.name,
      description: data.description || null,
      updated_at: new Date().toISOString()
    };

    updateDeck(
      {
        resource: "flashcard_decks",
        id: deck.id,
        values: updateData
      },
      {
        onSuccess: () => {
          toaster.create({
            title: "Success",
            description: "Deck updated successfully",
            type: "success"
          });
          setIsEditing(false);
          refetchDeck();
        },
        onError: (error) => {
          toaster.create({
            title: "Error",
            description: "Failed to update deck: " + error.message,
            type: "error"
          });
        }
      }
    );
  };

  const handleFlashcardAdded = () => {
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
    <VStack align="stretch" w="100%" gap={6} p={6}>
      {/* Header Section */}
      <HStack justifyContent="space-between" alignItems="start">
        <HStack gap={4}>
          <Link href={`/course/${course_id}/manage/course/flashcard-decks`}>
            <IconButton variant="ghost" size="sm">
              <FaArrowLeft />
            </IconButton>
          </Link>
          <VStack align="start" gap={1}>
            <HStack gap={2}>
              <Heading size="lg">{deck.name}</Heading>
              <Badge colorPalette="blue">{flashcards.length} cards</Badge>
            </HStack>
            <Text fontSize="sm">
              Created {format(new Date(deck.created_at), "MMM d, yyyy 'at' h:mm a")}
              {deck.updated_at && deck.updated_at !== deck.created_at && (
                <> • Updated {format(new Date(deck.updated_at), "MMM d, yyyy 'at' h:mm a")}</>
              )}
            </Text>
          </VStack>
        </HStack>

        <HStack gap={2}>
          {!isEditing ? (
            <Button onClick={handleEdit} variant="outline">
              <FaEdit style={{ marginRight: "8px" }} />
              Edit Deck
            </Button>
          ) : (
            <HStack gap={2}>
              <Button onClick={handleSubmit(handleSave)} loading={isUpdating} disabled={!isDirty}>
                <FaSave style={{ marginRight: "8px" }} />
                Save Changes
              </Button>
              <Button onClick={handleCancel} variant="outline">
                <FaTimes style={{ marginRight: "8px" }} />
                Cancel
              </Button>
            </HStack>
          )}
        </HStack>
      </HStack>

      {/* Deck Details Section */}
      <Box p={6} rounded="lg" border="1px">
        <VStack align="stretch" gap={4}>
          <Field label="Deck Name" required invalid={!!errors.name}>
            {isEditing ? (
              <Input {...register("name", { required: "Name is required" })} placeholder="Enter deck name" />
            ) : (
              <Text fontWeight="medium">{deck.name}</Text>
            )}
          </Field>

          <Field label="Description" invalid={!!errors.description}>
            {isEditing ? (
              <Textarea {...register("description")} placeholder="Enter deck description" rows={3} />
            ) : (
              <Text>{deck.description || "No description provided"}</Text>
            )}
          </Field>
        </VStack>
      </Box>

      {/* Flashcards Section */}
      <VStack align="stretch" gap={4}>
        <HStack justifyContent="space-between" alignItems="center">
          <Heading size="md">Flashcards ({flashcards.length})</Heading>
          <Button onClick={() => openAddCardModal()}>
            <FaPlus style={{ marginRight: "8px" }} />
            Add Flashcard
          </Button>
        </HStack>

        {isFlashcardsLoading ? (
          <VStack align="center" justify="center" h="100px">
            <Spinner />
            <Text>Loading flashcards...</Text>
          </VStack>
        ) : flashcards.length === 0 ? (
          <Box p={8} rounded="lg" border="1px" textAlign="center">
            <Text mb={4}>No flashcards in this deck yet</Text>
            <Button onClick={() => openAddCardModal()}>
              <FaPlus style={{ marginRight: "8px" }} />
              Add Your First Flashcard
            </Button>
          </Box>
        ) : (
          <VStack align="stretch" gap={3}>
            {flashcards.map((card, index) => (
              <Box key={card.id} p={4} rounded="lg" border="1px" shadow="sm">
                <HStack justifyContent="space-between" alignItems="start">
                  <VStack align="start" gap={2} flex={1}>
                    <HStack gap={2}>
                      <Badge variant="outline">{index + 1}</Badge>
                      <Text fontWeight="medium">{card.title}</Text>
                    </HStack>
                    <Box>
                      <Text fontSize="sm" mb={1}>
                        Prompt:
                      </Text>
                      <Text fontSize="sm">{card.prompt}</Text>
                    </Box>
                    <Box>
                      <Text fontSize="sm" mb={1}>
                        Answer:
                      </Text>
                      <Text fontSize="sm">{card.answer}</Text>
                    </Box>
                  </VStack>

                  <HStack gap={2}>
                    <Link href={`/course/${course_id}/manage/course/flashcard-decks/${deck_id}/flashcard/${card.id}`}>
                      <Button size="sm" variant="outline">
                        <FaEdit style={{ marginRight: "4px" }} />
                        Edit
                      </Button>
                    </Link>
                    <PopConfirm
                      triggerLabel="Delete flashcard"
                      trigger={
                        <IconButton size="sm" variant="outline" colorPalette="red">
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
    </VStack>
  );
}
