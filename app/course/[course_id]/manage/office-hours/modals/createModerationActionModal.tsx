"use client";

import { Box, Dialog, Field, HStack, Icon, Input, Stack, NativeSelect, Text, Textarea } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useCreate, useList } from "@refinedev/core";
import { useForm } from "react-hook-form";
import { useParams } from "next/navigation";
import { BsX } from "react-icons/bs";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useOfficeHoursRealtime } from "@/hooks/useOfficeHoursRealtime";
import { useEffect } from "react";
import { toaster } from "@/components/ui/toaster";
import type { HelpRequestModeration, HelpRequest } from "@/utils/supabase/DatabaseTypes";

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
 * Uses real-time updates to ensure student and help request lists are current.
 */
export default function CreateModerationActionModal({ isOpen, onClose, onSuccess }: CreateModerationActionModalProps) {
  const { course_id } = useParams();
  const { private_profile_id } = useClassProfiles();

  // Set up real-time subscriptions to get updated help request data
  const { isConnected, connectionStatus } = useOfficeHoursRealtime({
    classId: Number(course_id),
    enableGlobalQueues: true, // Get updates for help request changes
    enableStaffData: true // Get staff data updates
  });

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
      help_request_id: undefined as unknown as number,
      message_id: null,
      is_permanent: false
    }
  });

  const actionType = watch("action_type");

  // Fetch students in the class (excluding instructors and graders)
  const { data: studentsResponse, refetch: refetchStudents } = useList({
    resource: "user_roles",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "role", operator: "eq", value: "student" }
    ],
    pagination: { current: 1, pageSize: 1000 },
    meta: {
      select: "private_profile_id,profiles!user_roles_private_profile_id_fkey!inner(id,name,avatar_url)"
    }
  });

  // Fetch help requests for reference
  const { data: helpRequestsResponse, refetch: refetchHelpRequests } = useList<HelpRequest>({
    resource: "help_requests",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    pagination: { current: 1, pageSize: 100 },
    sorters: [{ field: "created_at", order: "desc" }]
  });

  const { mutateAsync: createModerationAction } = useCreate<HelpRequestModeration>();

  // Set up realtime message handling to refresh data when needed
  useEffect(() => {
    if (!isConnected) return;

    console.log("Moderation action modal realtime connection established");

    // Refresh help requests when realtime connection is established
    // This ensures we have the most up-to-date help request list
    const refreshData = () => {
      refetchHelpRequests();
      refetchStudents();
    };

    // Refresh data immediately when connected
    refreshData();
  }, [isConnected, refetchHelpRequests, refetchStudents]);

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

      await createModerationAction({
        resource: "help_request_moderation",
        values: {
          class_id: Number(course_id),
          student_profile_id: data.student_profile_id,
          moderator_profile_id: private_profile_id,
          action_type: data.action_type,
          reason: data.reason || null,
          duration_minutes: data.duration_minutes || null,
          help_request_id: data.help_request_id,
          message_id: data.message_id || null,
          is_permanent: data.action_type === "permanent_ban",
          expires_at
        },
        successNotification: {
          message: "Moderation action created successfully",
          type: "success"
        },
        errorNotification: {
          message: "Failed to create moderation action",
          type: "error"
        }
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

  const students = studentsResponse?.data ?? [];
  const helpRequests = helpRequestsResponse?.data ?? [];

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="lg">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>
              Create Moderation Action
              {isConnected && (
                <Text as="span" fontSize="xs" color="green.500" ml={2}>
                  ● Live data
                </Text>
              )}
            </Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" size="sm">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
            {/* Connection Status Warning */}
            {!isConnected && (
              <Box mb={4} p={3} borderRadius="md" bg="yellow.50" borderWidth="1px" borderColor="yellow.200">
                <Text fontSize="sm" color="yellow.700">
                  <strong>Warning:</strong> Real-time updates disconnected. Student and help request lists may not be
                  current. Status: {connectionStatus?.overall}
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
                      {students.map((userRole) => (
                        <option key={userRole.private_profile_id} value={userRole.private_profile_id}>
                          {userRole.profiles?.name || "Unknown Student"}
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Field.ErrorText>{errors.student_profile_id?.message}</Field.ErrorText>
                  <Field.HelperText>
                    {students.length} students available
                    {isConnected && <Text as="span"> (live updated)</Text>}
                  </Field.HelperText>
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
                      <option value="message_deleted">Message Deleted</option>
                      <option value="message_edited">Message Edited</option>
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
                  <Field.HelperText>
                    {helpRequests.length} help requests available
                    {isConnected && <Text as="span"> (live updated)</Text>}
                  </Field.HelperText>
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
              <Button variant="outline" onClick={handleClose}>
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
