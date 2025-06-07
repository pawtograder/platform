"use client";

import { VStack, Textarea } from "@chakra-ui/react";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import { useOne, useUpdate } from "@refinedev/core";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { toaster } from "@/components/ui/toaster";
import { Database } from "@/utils/supabase/SupabaseTypes";

// Supabase types
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];
type FlashcardUpdate = Database["public"]["Tables"]["flashcards"]["Update"];

/**
 * This type defines the props for the EditFlashCardModal component.
 * @param isOpen - Whether the modal is open
 * @param onClose - The function to call when the modal is closed
 * @param flashcardId - The ID of the flashcard to edit
 * @param onSuccess - The function to call when the flashcard is updated successfully
 */
type EditFlashCardModalProps = {
  isOpen: boolean;
  onClose: () => void;
  flashcardId: number;
  onSuccess?: () => void;
};

/**
 * This type defines the form data for the EditFlashCardModal component.
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
 * This component displays a modal for editing a flashcard.
 * It allows the user to edit the title, prompt, and answer of a flashcard.
 * @param isOpen - Whether the modal is open
 * @param onClose - The function to call when the modal is closed
 * @param flashcardId - The ID of the flashcard to edit
 * @param onSuccess - The function to call when the flashcard is updated successfully
 * @returns The EditFlashCardModal component
 */
export default function EditFlashCardModal({ isOpen, onClose, flashcardId, onSuccess }: EditFlashCardModalProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty }
  } = useForm<FlashcardFormData>();

  // Fetch existing flashcard data
  const { data: flashcardData, isLoading: isLoadingFlashcard } = useOne<FlashcardRow>({
    resource: "flashcards",
    id: flashcardId,
    queryOptions: {
      enabled: isOpen && !!flashcardId
    }
  });

  // Update flashcard mutation
  const { mutate: updateFlashcard, isLoading: isUpdating } = useUpdate();

  const flashcard = flashcardData?.data;

  // Reset form when flashcard data changes
  useEffect(() => {
    if (flashcard && isOpen) {
      reset({
        title: flashcard.title,
        prompt: flashcard.prompt,
        answer: flashcard.answer
      });
    }
  }, [flashcard, isOpen, reset]);

  const handleClose = () => {
    reset();
    onClose();
  };

  const onSubmit = (data: FlashcardFormData) => {
    if (!flashcard) return;

    const updateData: FlashcardUpdate = {
      title: data.title,
      prompt: data.prompt,
      answer: data.answer,
      updated_at: new Date().toISOString()
    };

    updateFlashcard(
      {
        resource: "flashcards",
        id: flashcard.id,
        values: updateData
      },
      {
        onSuccess: () => {
          toaster.create({
            title: "Success",
            description: "Flashcard updated successfully",
            type: "success"
          });

          handleClose();
          onSuccess?.();
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

  return (
    <DialogRoot open={isOpen} onOpenChange={(e) => (e.open ? undefined : handleClose())}>
      <DialogContent maxW="2xl">
        <DialogHeader pb={4}>
          <DialogTitle fontSize="xl" fontWeight="semibold">
            Edit Flashcard
          </DialogTitle>
        </DialogHeader>

        <DialogBody py={0}>
          {isLoadingFlashcard ? (
            <VStack align="center" justify="center" h="200px">
              <Button loading disabled>
                Loading flashcard...
              </Button>
            </VStack>
          ) : (
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
          )}
        </DialogBody>

        <DialogFooter pt={6}>
          <Button variant="outline" onClick={handleClose} disabled={isUpdating || isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit(onSubmit)}
            loading={isUpdating || isSubmitting}
            disabled={!isDirty || isLoadingFlashcard}
            colorPalette="green"
          >
            Update Flashcard
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
