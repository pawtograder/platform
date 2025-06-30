"use client";

import { Box, Dialog, Field, HStack, Icon, Input, Stack, Textarea, Text } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useUpdate } from "@refinedev/core";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import { BsX } from "react-icons/bs";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { toaster } from "@/components/ui/toaster";

type StudentKarmaNotes = Database["public"]["Tables"]["student_karma_notes"]["Row"];
type Profile = Database["public"]["Tables"]["profiles"]["Row"];

type KarmaEntryWithDetails = StudentKarmaNotes & {
  student_profile?: Profile;
  created_by?: { name: string };
};

type KarmaEntryFormData = {
  karma_score: number;
  internal_notes: string;
};

type EditKarmaEntryModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  karmaEntry?: KarmaEntryWithDetails;
};

/**
 * Modal component for editing existing student karma entries.
 * Allows instructors and TAs to modify karma scores and notes.
 */
export default function EditKarmaEntryModal({ isOpen, onClose, onSuccess, karmaEntry }: EditKarmaEntryModalProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<KarmaEntryFormData>();

  const { mutateAsync: updateKarmaEntry } = useUpdate();

  // Reset form when karma entry changes or modal opens
  useEffect(() => {
    if (isOpen && karmaEntry) {
      reset({
        karma_score: karmaEntry.karma_score,
        internal_notes: karmaEntry.internal_notes || ""
      });
    }
  }, [isOpen, karmaEntry, reset]);

  const handleClose = () => {
    reset();
    onClose();
  };

  const onSubmit = async (data: KarmaEntryFormData) => {
    if (!karmaEntry) return;

    try {
      await updateKarmaEntry({
        resource: "student_karma_notes",
        id: karmaEntry.id,
        values: {
          karma_score: data.karma_score,
          internal_notes: data.internal_notes || null,
          updated_at: new Date().toISOString()
        },
        successNotification: {
          message: "Student karma entry updated successfully",
          type: "success"
        },
        errorNotification: {
          message: "Failed to update karma entry",
          type: "error"
        }
      });
      handleClose();
      onSuccess();
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to update karma entry: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  if (!karmaEntry) return null;

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="lg">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Edit Student Karma Entry</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" size="sm">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
            <form onSubmit={handleSubmit(onSubmit)}>
              <Stack spaceY={4}>
                {/* Student info (read-only) */}
                <Box p={3} borderRadius="md">
                  <Text fontSize="sm" fontWeight="semibold">
                    Student
                  </Text>
                  <Text fontWeight="medium">{karmaEntry.student_profile?.name || "Unknown Student"}</Text>
                </Box>

                <Field.Root invalid={!!errors.karma_score}>
                  <Field.Label>Karma Score</Field.Label>
                  <Input
                    type="number"
                    {...register("karma_score", {
                      valueAsNumber: true,
                      required: "Karma score is required",
                      min: { value: -20, message: "Karma score cannot be less than -20" },
                      max: { value: 20, message: "Karma score cannot be more than 20" }
                    })}
                    placeholder="0"
                  />
                  <Field.ErrorText>{errors.karma_score?.message}</Field.ErrorText>
                  <Field.HelperText>
                    Range: -20 to +20. Positive scores indicate good behavior, negative scores indicate issues.
                  </Field.HelperText>
                </Field.Root>

                <Field.Root invalid={!!errors.internal_notes}>
                  <Field.Label>Internal Notes</Field.Label>
                  <Textarea
                    {...register("internal_notes", {
                      required: "Internal notes are required",
                      minLength: { value: 10, message: "Notes must be at least 10 characters" }
                    })}
                    placeholder="Add detailed notes about the student's behavior or participation..."
                    rows={4}
                  />
                  <Field.ErrorText>{errors.internal_notes?.message}</Field.ErrorText>
                  <Field.HelperText>
                    These notes are internal only and will not be visible to students.
                  </Field.HelperText>
                </Field.Root>

                <Box p={3} borderRadius="md" borderWidth="1px">
                  <Text fontSize="sm">
                    <strong>Karma Guidelines:</strong>
                    <br />
                    +10 to +20: Exceptional help to others, outstanding participation
                    <br />
                    +5 to +9: Helpful behavior, good participation
                    <br />
                    0 to +4: Neutral behavior
                    <br />
                    -1 to -5: Minor issues, occasional disruption
                    <br />
                    -6 to -20: Serious behavioral problems, repeated violations
                  </Text>
                </Box>
              </Stack>
            </form>
          </Dialog.Body>

          <Dialog.Footer>
            <HStack justify="end" gap={3}>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button colorPalette="green" onClick={handleSubmit(onSubmit)} loading={isSubmitting}>
                Update Karma Entry
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
