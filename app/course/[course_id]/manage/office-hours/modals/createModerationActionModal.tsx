"use client";

import { Box, Dialog, Field, HStack, Icon, Input, Stack, NativeSelect, Text, Textarea } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { useParams } from "next/navigation";
import { BsX } from "react-icons/bs";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useStudentRoster } from "@/hooks/useCourseController";
import { useHelpRequests, useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import { useMemo } from "react";
import { toaster } from "@/components/ui/toaster";
import type { UserProfile } from "@/utils/supabase/DatabaseTypes";

type ModerationActionFormData = {
  student_profile_id: string;
  action_type: "warning" | "temporary_ban" | "permanent_ban" | "message_deleted" | "message_edited";
  reason: string;
  duration_minutes: number | null;
  help_request_id: number;
  message_id: number | null;
  is_permanent: boolean;
};

type CreateModerationActionModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

/**
 * Modal component for creating new moderation actions.
 * Allows instructors and TAs to issue warnings, bans, and other moderation actions.
 * Uses real-time data for help requests to ensure current information.
 */
export default function CreateModerationActionModal({ isOpen, onClose, onSuccess }: CreateModerationActionModalProps) {
  const { course_id } = useParams();
  const { private_profile_id } = useClassProfiles();

  // Get realtime help requests data
  const allHelpRequests = useHelpRequests();

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<ModerationActionFormData>({
    defaultValues: {
      student_profile_id: "",
      action_type: "warning",
      reason: "",
      duration_minutes: null,
      help_request_id: undefined,
      message_id: null,
      is_permanent: false
    }
  });

  const actionType = watch("action_type");

  // Get students from the cached roster
  const students = useStudentRoster();

  // Filter help requests for this class and sort by most recent
  const helpRequests = useMemo(() => {
    return allHelpRequests
      .filter((request) => request.class_id === Number(course_id))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 100); // Limit to 100 most recent
  }, [allHelpRequests, course_id]);

  // Get table controllers from office hours controller
  const controller = useOfficeHoursController();
  const { helpRequestModeration } = controller;

  const handleClose = () => {
    reset();
    onClose();
  };

  const onSubmit = async (data: ModerationActionFormData) => {
    if (!private_profile_id) {
      toaster.error({
        title: "Error",
        description: "You must be logged in to create moderation actions"
      });
      return;
    }

    try {
      // Calculate expires_at for temporary bans
      let expires_at: string | null = null;
      if (data.action_type === "temporary_ban" && data.duration_minutes) {
        const expirationDate = new Date();
        expirationDate.setMinutes(expirationDate.getMinutes() + data.duration_minutes);
        expires_at = expirationDate.toISOString();
      }

      await helpRequestModeration.create({
        class_id: Number(course_id),
        student_profile_id: data.student_profile_id,
        moderator_profile_id: private_profile_id,
        action_type: data.action_type as "warning" | "temporary_ban" | "permanent_ban",
        reason: data.reason || null,
        duration_minutes: data.duration_minutes || null,
        help_request_id: data.help_request_id,
        message_id: data.message_id || null,
        is_permanent: data.action_type === "permanent_ban",
        expires_at
      });

      toaster.success({
        title: "Success",
        description: "Moderation action created successfully"
      });
      handleClose();
      onSuccess();
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to create moderation action: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  // Handle action type change to set default values
  const handleActionTypeChange = (newActionType: string) => {
    setValue(
      "action_type",
      newActionType as "warning" | "temporary_ban" | "permanent_ban" | "message_deleted" | "message_edited"
    );
    if (newActionType === "permanent_ban") {
      setValue("is_permanent", true);
      setValue("duration_minutes", null);
    } else if (newActionType === "temporary_ban") {
      setValue("is_permanent", false);
      setValue("duration_minutes", 60); // Default to 1 hour
    } else {
      setValue("is_permanent", false);
      setValue("duration_minutes", null);
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="lg">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Create Moderation Action</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" colorPalette="red" size="sm">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
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
                      {students?.map((profile: UserProfile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name || "Unknown Student"}
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Field.ErrorText>{errors.student_profile_id?.message}</Field.ErrorText>
                  <Field.HelperText>{students?.length} students available</Field.HelperText>
                </Field.Root>

                <Field.Root invalid={!!errors.action_type}>
                  <Field.Label>Action Type</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field
                      {...register("action_type", { required: "Action type is required" })}
                      onChange={(e) => handleActionTypeChange(e.target.value)}
                    >
                      <option value="warning">Warning</option>
                      <option value="temporary_ban">Temporary Ban</option>
                      <option value="permanent_ban">Permanent Ban</option>
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Field.ErrorText>{errors.action_type?.message}</Field.ErrorText>
                  <Field.HelperText>The type of moderation action to take against this student</Field.HelperText>
                </Field.Root>

                {actionType === "temporary_ban" && (
                  <Field.Root invalid={!!errors.duration_minutes}>
                    <Field.Label>Ban Duration (minutes)</Field.Label>
                    <Input
                      type="number"
                      min="1"
                      {...register("duration_minutes", {
                        valueAsNumber: true,
                        required: actionType === "temporary_ban" ? "Duration is required for temporary bans" : false,
                        min: { value: 1, message: "Duration must be at least 1 minute" }
                      })}
                      placeholder="60"
                    />
                    <Field.ErrorText>{errors.duration_minutes?.message}</Field.ErrorText>
                    <Field.HelperText>
                      How long the ban should last (e.g., 60 for 1 hour, 1440 for 24 hours)
                    </Field.HelperText>
                  </Field.Root>
                )}

                <Field.Root invalid={!!errors.reason}>
                  <Field.Label>Reason</Field.Label>
                  <Textarea
                    {...register("reason", {
                      required: "Reason is required",
                      minLength: { value: 10, message: "Reason must be at least 10 characters" }
                    })}
                    placeholder="Explain why this moderation action is being taken..."
                    rows={4}
                  />
                  <Field.ErrorText>{errors.reason?.message}</Field.ErrorText>
                  <Field.HelperText>Provide a clear explanation for this moderation action</Field.HelperText>
                </Field.Root>

                <Field.Root invalid={!!errors.help_request_id}>
                  <Field.Label>Help Request</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field
                      {...register("help_request_id", {
                        valueAsNumber: true,
                        required: "Help request is required"
                      })}
                    >
                      <option value="">Select a help request</option>
                      {helpRequests.map((request) => (
                        <option key={request.id} value={request.id}>
                          #{request.id} - {request.request.substring(0, 50)}...
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Field.ErrorText>{errors.help_request_id?.message}</Field.ErrorText>
                  <Field.HelperText>{helpRequests.length} help requests available</Field.HelperText>
                </Field.Root>

                {actionType === "permanent_ban" && (
                  <Box p={3} bg="red.50" borderRadius="md" borderWidth="1px" borderColor="red.200">
                    <Text color="red.700" fontSize="sm">
                      <strong>Warning:</strong> Permanent bans cannot be automatically reversed and will prevent the
                      student from participating in office hours indefinitely.
                    </Text>
                  </Box>
                )}
              </Stack>
            </form>
          </Dialog.Body>

          <Dialog.Footer>
            <HStack justify="end" gap={3}>
              <Button colorPalette="red" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                colorPalette={actionType === "permanent_ban" ? "red" : "orange"}
                onClick={handleSubmit(onSubmit)}
                loading={isSubmitting}
              >
                Create{" "}
                {actionType === "warning"
                  ? "Warning"
                  : actionType === "temporary_ban"
                    ? "Temporary Ban"
                    : actionType === "permanent_ban"
                      ? "Permanent Ban"
                      : "Action"}
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
