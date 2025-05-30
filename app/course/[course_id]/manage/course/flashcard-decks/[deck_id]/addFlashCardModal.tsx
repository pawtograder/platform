"use client";

import { VStack, Textarea } from "@chakra-ui/react";
import { useForm } from "react-hook-form";
import { useParams } from "next/navigation";
import { useCreate } from "@refinedev/core";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { toaster } from "@/components/ui/toaster";
import { Database } from "@/utils/supabase/SupabaseTypes";
import useAuthState from "@/hooks/useAuthState";

// Type definitions
type FlashcardInsert = Database["public"]["Tables"]["flashcards"]["Insert"];

interface AddFlashCardModalProps {
  isOpen: boolean;
  onClose: () => void;
  deckId: string;
  onSuccess?: () => void;
}

interface FlashcardFormData {
  title: string;
  prompt: string;
  answer: string;
}

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Flashcard</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit(onSubmit)}>
            <VStack align="stretch" gap={4}>
              <Field label="Title" required invalid={!!errors.title} errorText={errors.title?.message}>
                <Input
                  {...register("title", {
                    required: "Title is required",
                    minLength: { value: 1, message: "Title cannot be empty" }
                  })}
                  placeholder="Enter flashcard title"
                />
              </Field>

              <Field label="Prompt" required invalid={!!errors.prompt} errorText={errors.prompt?.message}>
                <Textarea
                  {...register("prompt", {
                    required: "Prompt is required",
                    minLength: { value: 1, message: "Prompt cannot be empty" }
                  })}
                  placeholder="Enter the question or prompt"
                  rows={3}
                />
              </Field>

              <Field label="Answer" required invalid={!!errors.answer} errorText={errors.answer?.message}>
                <Textarea
                  {...register("answer", {
                    required: "Answer is required",
                    minLength: { value: 1, message: "Answer cannot be empty" }
                  })}
                  placeholder="Enter the answer"
                  rows={3}
                />
              </Field>
            </VStack>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit(onSubmit)} loading={isCreating || isSubmitting}>
            Add Flashcard
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
