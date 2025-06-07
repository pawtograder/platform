"use client";

import { VStack, Textarea } from "@chakra-ui/react";
import { useForm } from "react-hook-form";
import { useParams } from "next/navigation";
import { useCreate } from "@refinedev/core";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { toaster } from "@/components/ui/toaster";
import { Database } from "@/utils/supabase/SupabaseTypes";
import useAuthState from "@/hooks/useAuthState";

// Supabase types
type FlashcardInsert = Database["public"]["Tables"]["flashcards"]["Insert"];

/**
 * This type defines the props for the AddFlashCardModal component.
 * @param isOpen - Whether the modal is open
 * @param onClose - The function to call when the modal is closed
 * @param deckId - The ID of the deck to add a flashcard to
 * @param onSuccess - The function to call when the flashcard is added successfully
 */
type AddFlashCardModalProps = {
  isOpen: boolean;
  onClose: () => void;
  deckId: string;
  onSuccess?: () => void;
};

/**
 * This type defines the form data for the AddFlashCardModal component.
 * @param title - The title of the flashcard
 * @param prompt - The prompt of the flashcard
 * @param answer - The answer of the flashcard
 */
type FlashcardFormData = {
  title: string;
  prompt: string;
  answer: string;
};

/**
 * This component displays a modal for adding a new flashcard to a deck.
 * It allows the user to enter a title, prompt, and answer for the flashcard.
 * @param isOpen - Whether the modal is open
 * @param onClose - The function to call when the modal is closed
 * @param deckId - The ID of the deck to add a flashcard to
 * @param onSuccess - The function to call when the flashcard is added successfully
 * @returns The AddFlashCardModal component
 */
export default function AddFlashCardModal({ isOpen, onClose, deckId, onSuccess }: AddFlashCardModalProps) {
  const params = useParams();
  const course_id = params.course_id as string;
  const { user } = useAuthState();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<FlashcardFormData>();

  // Create flashcard mutation
  const { mutate: createFlashcard, isLoading: isCreating } = useCreate();

  const handleClose = () => {
    reset();
    onClose();
  };

  const onSubmit = (data: FlashcardFormData) => {
    if (!user) {
      toaster.create({
        title: "Error",
        description: "You must be logged in to create flashcards",
        type: "error"
      });
      return;
    }

    const flashcardData: FlashcardInsert = {
      title: data.title,
      prompt: data.prompt,
      answer: data.answer,
      deck_id: parseInt(deckId),
      class_id: parseInt(course_id),
      order: null // Will be set by the database or can be calculated
    };

    createFlashcard(
      {
        resource: "flashcards",
        values: flashcardData
      },
      {
        onSuccess: () => {
          toaster.create({
            title: "Success",
            description: "Flashcard created successfully",
            type: "success"
          });

          reset();
          handleClose();
          onSuccess?.();
        },
        onError: (error) => {
          toaster.create({
            title: "Error",
            description: "Failed to create flashcard: " + error.message,
            type: "error"
          });
        }
      }
    );
  };

  return (
    <DialogRoot open={isOpen} onOpenChange={(e) => (e.open ? undefined : handleClose())}>
      <DialogContent maxW="2xl">
        <DialogHeader pb={4}>
          <DialogTitle fontSize="xl" fontWeight="semibold">
            Add New Flashcard
          </DialogTitle>
        </DialogHeader>

        <DialogBody py={0}>
          <form onSubmit={handleSubmit(onSubmit)}>
            <VStack align="stretch" gap={6}>
              <Field label="Title" required invalid={!!errors.title} errorText={errors.title?.message}>
                <Textarea
                  {...register("title", {
                    required: "Title is required",
                    minLength: { value: 1, message: "Title cannot be empty" }
                  })}
                  placeholder="Enter flashcard title"
                  rows={1}
                  resize="vertical"
                />
              </Field>

              <Field label="Prompt" required invalid={!!errors.prompt} errorText={errors.prompt?.message}>
                <Textarea
                  {...register("prompt", {
                    required: "Prompt is required",
                    minLength: { value: 1, message: "Prompt cannot be empty" }
                  })}
                  placeholder="Enter the question or prompt"
                  rows={4}
                  resize="vertical"
                />
              </Field>

              <Field label="Answer" required invalid={!!errors.answer} errorText={errors.answer?.message}>
                <Textarea
                  {...register("answer", {
                    required: "Answer is required",
                    minLength: { value: 1, message: "Answer cannot be empty" }
                  })}
                  placeholder="Enter the answer"
                  rows={4}
                  resize="vertical"
                />
              </Field>
            </VStack>
          </form>
        </DialogBody>

        <DialogFooter pt={6}>
          <Button variant="outline" onClick={handleClose} disabled={isCreating || isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit(onSubmit)} loading={isCreating || isSubmitting} colorPalette="green">
            Add Flashcard
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
