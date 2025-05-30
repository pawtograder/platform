"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { VStack, HStack, Heading, Text, Box, IconButton, Spinner, Textarea } from "@chakra-ui/react";
import { useForm } from "react-hook-form";
import { useOne, useUpdate, useDelete } from "@refinedev/core";
import { FaEdit, FaSave, FaTimes, FaTrash, FaArrowLeft } from "react-icons/fa";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PopConfirm } from "@/components/ui/popconfirm";
import Link from "@/components/ui/link";
import { toaster } from "@/components/ui/toaster";
import { Database } from "@/utils/supabase/SupabaseTypes";

// Type definitions
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];
type FlashcardUpdate = Database["public"]["Tables"]["flashcards"]["Update"];

interface FlashcardFormData {
  title: string;
  prompt: string;
  answer: string;
}

export default function FlashcardPage() {
  const params = useParams();
  const router = useRouter();
  const course_id = params.course_id as string;
  const deck_id = params.deck_id as string;
  const card_id = params.card_id as string;

  const [isEditing, setIsEditing] = useState(false);

  // Fetch flashcard data
  const {
    data: cardData,
    isLoading: isCardLoading,
    refetch: refetchCard
  } = useOne<FlashcardRow>({
    resource: "flashcards",
    id: card_id,
    queryOptions: {
      enabled: !!card_id
    }
  });

  // Update flashcard mutation
  const { mutate: updateFlashcard, isLoading: isUpdating } = useUpdate();

  // Delete flashcard mutation
  const { mutate: deleteFlashcard, isLoading: isDeleting } = useDelete();

  // Form for editing flashcard
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty }
  } = useForm<FlashcardFormData>();

  const card = cardData?.data;

  // Reset form when card data changes or editing mode changes
  useEffect(() => {
    if (card && isEditing) {
      reset({
        title: card.title,
        prompt: card.prompt,
        answer: card.answer
      });
    }
  }, [card, isEditing, reset]);

  const handleEdit = () => {
    setIsEditing(true);
  };

  const handleCancel = () => {
    setIsEditing(false);
    reset();
  };

  const handleSave = (data: FlashcardFormData) => {
    if (!card) return;

    const updateData: FlashcardUpdate = {
      title: data.title,
      prompt: data.prompt,
      answer: data.answer,
      updated_at: new Date().toISOString()
    };

    updateFlashcard(
      {
        resource: "flashcards",
        id: card.id,
        values: updateData
      },
      {
        onSuccess: () => {
          toaster.create({
            title: "Success",
            description: "Flashcard updated successfully",
            type: "success"
          });
          setIsEditing(false);
          refetchCard();
        },
        onError: (error) => {
          toaster.create({
            title: "Error",
            description: "Failed to update flashcard: " + error.message,
            type: "error"
          });
        }
      }
    );
  };

  const handleDelete = () => {
    if (!card) return;

    deleteFlashcard(
      {
        resource: "flashcards",
        id: card.id,
        values: {
          deleted_at: new Date().toISOString()
        }
      },
      {
        onSuccess: () => {
          toaster.create({
            title: "Success",
            description: "Flashcard deleted successfully",
            type: "success"
          });
          // Navigate back to the deck page
          router.push(`/course/${course_id}/manage/course/flashcard-decks/${deck_id}`);
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

  if (isCardLoading) {
    return (
      <VStack align="center" justify="center" h="200px">
        <Spinner />
        <Text>Loading flashcard...</Text>
      </VStack>
    );
  }

  if (!card) {
    return (
      <VStack align="center" justify="center" h="200px">
        <Text>Flashcard not found</Text>
        <Button onClick={() => router.back()}>Go Back</Button>
      </VStack>
    );
  }

  return (
    <VStack align="stretch" w="100%" gap={6} p={6}>
      {/* Header Section */}
      <HStack justifyContent="space-between" alignItems="start">
        <HStack gap={4}>
          <Link href={`/course/${course_id}/manage/course/flashcard-decks/${deck_id}`}>
            <IconButton variant="ghost" size="sm">
              <FaArrowLeft />
            </IconButton>
          </Link>
          <VStack align="start" gap={1}>
            <Heading size="lg">{card.title}</Heading>
            <Text fontSize="sm">
              Created {format(new Date(card.created_at), "MMM d, yyyy 'at' h:mm a")}
              {card.updated_at && card.updated_at !== card.created_at && (
                <> • Updated {format(new Date(card.updated_at), "MMM d, yyyy 'at' h:mm a")}</>
              )}
            </Text>
          </VStack>
        </HStack>

        <HStack gap={2}>
          {!isEditing ? (
            <>
              <Button onClick={handleEdit} variant="outline">
                <FaEdit style={{ marginRight: "8px" }} />
                Edit Card
              </Button>
              <PopConfirm
                triggerLabel="Delete flashcard"
                trigger={
                  <Button variant="outline" colorPalette="red" loading={isDeleting}>
                    <FaTrash style={{ marginRight: "8px" }} />
                    Delete Card
                  </Button>
                }
                confirmHeader="Delete Flashcard"
                confirmText="Are you sure you want to delete this flashcard? This action cannot be undone."
                onConfirm={handleDelete}
                onCancel={() => {}}
              />
            </>
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

      {/* Flashcard Details Section */}
      <Box p={6} rounded="lg" border="1px">
        <VStack align="stretch" gap={4}>
          <Field label="Title" required invalid={!!errors.title} errorText={errors.title?.message}>
            {isEditing ? (
              <Input
                {...register("title", {
                  required: "Title is required",
                  minLength: { value: 1, message: "Title cannot be empty" }
                })}
                placeholder="Enter flashcard title"
              />
            ) : (
              <Text fontWeight="medium">{card.title}</Text>
            )}
          </Field>

          <Field label="Prompt" required invalid={!!errors.prompt} errorText={errors.prompt?.message}>
            {isEditing ? (
              <Textarea
                {...register("prompt", {
                  required: "Prompt is required",
                  minLength: { value: 1, message: "Prompt cannot be empty" }
                })}
                placeholder="Enter the question or prompt"
                rows={4}
              />
            ) : (
              <Box p={3} rounded="md" border="1px" bg="gray.50" _dark={{ bg: "gray.700" }}>
                <Text whiteSpace="pre-wrap">{card.prompt}</Text>
              </Box>
            )}
          </Field>

          <Field label="Answer" required invalid={!!errors.answer} errorText={errors.answer?.message}>
            {isEditing ? (
              <Textarea
                {...register("answer", {
                  required: "Answer is required",
                  minLength: { value: 1, message: "Answer cannot be empty" }
                })}
                placeholder="Enter the answer"
                rows={4}
              />
            ) : (
              <Box p={3} rounded="md" border="1px" bg="gray.50" _dark={{ bg: "gray.700" }}>
                <Text whiteSpace="pre-wrap">{card.answer}</Text>
              </Box>
            )}
          </Field>
        </VStack>
      </Box>

      {/* Additional Info Section */}
      <Box p={4} rounded="lg" border="1px" bg="gray.50" _dark={{ bg: "gray.800" }}>
        <VStack align="stretch" gap={2}>
          <Heading size="sm">Card Information</Heading>
          {card.order && (
            <Text fontSize="sm">
              <strong>Order:</strong> {card.order}
            </Text>
          )}
          <Text fontSize="sm">
            <strong>Created:</strong> {format(new Date(card.created_at), "PPpp")}
          </Text>
          {card.updated_at && card.updated_at !== card.created_at && (
            <Text fontSize="sm">
              <strong>Last Updated:</strong> {format(new Date(card.updated_at), "PPpp")}
            </Text>
          )}
        </VStack>
      </Box>
    </VStack>
  );
}
