"use client";

import { Box, Dialog, Field, HStack, Icon, Input, Stack, NativeSelect, Text, Textarea } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { useParams } from "next/navigation";
import { BsX } from "react-icons/bs";
import useAuthState from "@/hooks/useAuthState";
import { useConnectionStatus, useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import { useStudentRoster } from "@/hooks/useCourseController";
import { toaster } from "@/components/ui/toaster";
import type { UserProfile } from "@/utils/supabase/DatabaseTypes";

type KarmaEntryFormData = {
  student_profile_id: string;
  karma_score: number;
  internal_notes: string;
};

type CreateKarmaEntryModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

/**
 * Modal component for creating new student karma entries.
 * Allows instructors and TAs to add karma scores and notes for students.
 * Uses real-time updates to ensure student list is current.
 */
export default function CreateKarmaEntryModal({ isOpen, onClose, onSuccess }: CreateKarmaEntryModalProps) {
  const { course_id } = useParams();
  const { user } = useAuthState();

  // Monitor connection status for real-time updates
  const { isConnected, connectionStatus } = useConnectionStatus();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<KarmaEntryFormData>({
    defaultValues: {
      student_profile_id: "",
      karma_score: 0,
      internal_notes: ""
    }
  });

  // Get students from the cached roster
  const students = useStudentRoster();

  // Get table controllers from office hours controller
  const controller = useOfficeHoursController();
  const { studentKarmaNotes } = controller;

  const handleClose = () => {
    reset();
    onClose();
  };

  const onSubmit = async (data: KarmaEntryFormData) => {
    if (!user?.id) {
      toaster.error({
        title: "Error",
        description: "You must be logged in to create karma entries"
      });
      return;
    }

    try {
      const now = new Date().toISOString();

      await studentKarmaNotes.create({
        class_id: Number(course_id),
        student_profile_id: data.student_profile_id,
        karma_score: data.karma_score,
        internal_notes: data.internal_notes || null,
        created_by_id: user.id,
        last_activity_at: now
      });

      toaster.success({
        title: "Success",
        description: "Student karma entry created successfully"
      });
      handleClose();
      onSuccess();
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to create karma entry: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="lg">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Create Student Karma Entry</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" colorPalette="red" size="sm">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
            {/* Connection Status Warning */}
            {!isConnected && (
              <Box mb={4} p={3} borderRadius="md" bg="yellow.50" borderWidth="1px" borderColor="yellow.200">
                <Text fontSize="sm" color="yellow.700">
                  <strong>Warning:</strong> Real-time updates disconnected. Student list may not be current. Status:{" "}
                  {connectionStatus?.overall}
                </Text>
              </Box>
            )}

            <form onSubmit={handleSubmit(onSubmit)}>
              <Stack spaceY={4}>
                <Field.Root invalid={!!errors.student_profile_id}>
                  <Field.Label>Student</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field
                      {...register("student_profile_id", { required: "Student is required" })}
                      placeholder="Select a student"
                    >
                      <option value="">Select a student</option>
                      {students.map((profile: UserProfile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name || "Unknown Student"}
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Field.ErrorText>{errors.student_profile_id?.message}</Field.ErrorText>
                  <Field.HelperText>{students.length} students available</Field.HelperText>
                </Field.Root>

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
              <Button colorPalette="red" onClick={handleClose}>
                Cancel
              </Button>
              <Button colorPalette="green" onClick={handleSubmit(onSubmit)} loading={isSubmitting}>
                Create Karma Entry
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
