"use client";

import { Box, Dialog, Field, HStack, Icon, Input, Stack, NativeSelect, Textarea } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useCreate } from "@refinedev/core";
import { useForm } from "react-hook-form";
import { useParams } from "next/navigation";
import { BsX } from "react-icons/bs";
import { toaster } from "@/components/ui/toaster";
import type { HelpQueue } from "@/utils/supabase/DatabaseTypes";

type HelpQueueFormData = {
  name: string;
  description: string;
  queue_type: "text" | "video" | "in_person";
  available: boolean;
  is_active: boolean;
  max_concurrent_requests: number | null;
  color: string | null;
  closing_at: string | null;
};

type CreateHelpQueueModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

/**
 * Modal component for creating new help queues.
 * Allows instructors to configure all queue properties.
 */
export default function CreateHelpQueueModal({ isOpen, onClose, onSuccess }: CreateHelpQueueModalProps) {
  const { course_id } = useParams();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<HelpQueueFormData>({
    defaultValues: {
      name: "",
      description: "",
      queue_type: "text",
      available: true,
      is_active: true,
      max_concurrent_requests: null,
      color: null,
      closing_at: null
    }
  });

  const { mutateAsync: createQueue } = useCreate<HelpQueue>();

  const handleClose = () => {
    reset();
    onClose();
  };

  const onSubmit = async (data: HelpQueueFormData) => {
    try {
      await createQueue({
        resource: "help_queues",
        values: {
          class_id: Number(course_id),
          name: data.name,
          description: data.description,
          queue_type: data.queue_type,
          available: data.available,
          is_active: data.is_active,
          max_concurrent_requests: data.max_concurrent_requests || null,
          color: data.color || null,
          closing_at: data.closing_at || null,
          depth: 0 // Initialize with 0 depth
        },
        successNotification: {
          message: "Help queue created successfully",
          type: "success"
        },
        errorNotification: {
          message: "Failed to create help queue",
          type: "error"
        }
      });
      handleClose();
      onSuccess();
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to create help queue: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="lg">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Create New Help Queue</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" size="sm">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
            <form onSubmit={handleSubmit(onSubmit)}>
              <Stack spaceY={4}>
                <Field.Root invalid={!!errors.name}>
                  <Field.Label>Queue Name</Field.Label>
                  <Input
                    {...register("name", {
                      required: "Queue name is required",
                      minLength: { value: 2, message: "Name must be at least 2 characters" }
                    })}
                    placeholder="e.g., General Help, Lab 3 Questions"
                  />
                  <Field.ErrorText>{errors.name?.message}</Field.ErrorText>
                </Field.Root>

                <Field.Root>
                  <Field.Label>Description</Field.Label>
                  <Textarea {...register("description")} placeholder="Describe what this queue is for..." rows={3} />
                  <Field.HelperText>
                    Optional description to help students understand when to use this queue
                  </Field.HelperText>
                </Field.Root>

                <Field.Root invalid={!!errors.queue_type}>
                  <Field.Label>Queue Type</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field {...register("queue_type", { required: "Queue type is required" })}>
                      <option value="text">Text Chat</option>
                      <option value="video">Video Call</option>
                      <option value="in_person">In Person</option>
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Field.ErrorText>{errors.queue_type?.message}</Field.ErrorText>
                  <Field.HelperText>Determines how students and TAs will interact in this queue</Field.HelperText>
                </Field.Root>

                <Field.Root>
                  <Field.Label>Max Concurrent Requests</Field.Label>
                  <Input
                    type="number"
                    min="1"
                    {...register("max_concurrent_requests", {
                      valueAsNumber: true,
                      min: { value: 1, message: "Must be at least 1" }
                    })}
                    placeholder="Leave empty for no limit"
                  />
                  <Field.HelperText>Maximum number of requests that can be open at once in this queue</Field.HelperText>
                </Field.Root>

                <Field.Root>
                  <Field.Label>Color</Field.Label>
                  <Input type="color" {...register("color")} placeholder="#3182CE" />
                  <Field.HelperText>Optional color to help distinguish this queue</Field.HelperText>
                </Field.Root>

                <Field.Root>
                  <Field.Label>Closing Time</Field.Label>
                  <Input type="datetime-local" {...register("closing_at")} />
                  <Field.HelperText>Optional time when this queue will automatically close</Field.HelperText>
                </Field.Root>

                <Box>
                  <Field.Root>
                    <Field.Label>
                      <input type="checkbox" {...register("available")} style={{ marginRight: "8px" }} />
                      Queue is available to students
                    </Field.Label>
                    <Field.HelperText>Uncheck to make this queue unavailable for new requests</Field.HelperText>
                  </Field.Root>
                </Box>

                <Box>
                  <Field.Root>
                    <Field.Label>
                      <input type="checkbox" {...register("is_active")} style={{ marginRight: "8px" }} />
                      Queue is active
                    </Field.Label>
                    <Field.HelperText>Inactive queues are hidden from students</Field.HelperText>
                  </Field.Root>
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
                Create Queue
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
