"use client";

import { TopicIconPicker, TopicIconPickerValue } from "@/components/discussion/TopicIconPicker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, Field, HStack, Icon, Input, Stack, NativeSelect, Text, Textarea } from "@chakra-ui/react";
import { Controller, useForm } from "react-hook-form";
import { useEffect } from "react";
import { BsX } from "react-icons/bs";
import { useCourseController, useAssignments } from "@/hooks/useCourseController";
import type { DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import { toaster } from "@/components/ui/toaster";

/**
 * Available color options for discussion topics.
 * These correspond to Chakra UI color palettes.
 */
const TOPIC_COLORS = [
  { value: "red", label: "Red" },
  { value: "orange", label: "Orange" },
  { value: "yellow", label: "Yellow" },
  { value: "green", label: "Green" },
  { value: "teal", label: "Teal" },
  { value: "blue", label: "Blue" },
  { value: "cyan", label: "Cyan" },
  { value: "purple", label: "Purple" },
  { value: "pink", label: "Pink" },
  { value: "gray", label: "Gray" }
] as const;

/**
 * Form data structure for editing a discussion topic.
 */
type TopicFormData = {
  /** The display name of the topic */
  topic: string;
  /** A description explaining what the topic is for */
  description: string;
  /** The color palette used to style the topic */
  color: string;
  /** Optional assignment ID to link the topic to a specific assignment */
  assignment_id: string;
  /** Optional icon name */
  icon: string;
  /** Whether students should follow by default */
  default_follow: boolean;
};

/**
 * Props for the EditTopicModal component.
 */
type EditTopicModalProps = {
  /** Whether the modal is currently open */
  isOpen: boolean;
  /** Callback function to close the modal */
  onClose: () => void;
  /** Callback function called after successful topic update */
  onSuccess: () => void;
  /** The topic being edited, or undefined if no topic is selected */
  topic?: DiscussionTopic;
};

/**
 * Modal component for editing existing discussion topics.
 * Allows instructors to modify topic name, description, color, and assignment link.
 * Uses the TableController pattern for database operations with real-time updates.
 *
 * @param props - Component props
 * @param props.isOpen - Whether the modal is currently open
 * @param props.onClose - Callback function to close the modal
 * @param props.onSuccess - Callback function called after successful topic update
 * @param props.topic - The topic being edited
 * @returns The rendered modal component, or null if no topic is provided
 */
export default function EditTopicModal({ isOpen, onClose, onSuccess, topic }: EditTopicModalProps) {
  const controller = useCourseController();
  const assignments = useAssignments();

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<TopicFormData>();

  /**
   * Reset form values when the modal opens or the topic changes.
   */
  useEffect(() => {
    if (isOpen && topic) {
      reset({
        topic: topic.topic,
        description: topic.description || "",
        color: topic.color,
        assignment_id: topic.assignment_id?.toString() || "",
        icon: topic.icon ?? "",
        default_follow: topic.default_follow ?? false
      });
    }
  }, [isOpen, topic, reset]);

  /**
   * Handles modal close by resetting form state.
   */
  const handleClose = () => {
    reset();
    onClose();
  };

  /**
   * Handles form submission to update the discussion topic.
   * @param data - The form data containing updated topic details
   */
  const onSubmit = async (data: TopicFormData) => {
    if (!topic) return;

    try {
      await controller.discussionTopics.update(topic.id, {
        topic: data.topic,
        description: data.description,
        color: data.color,
        assignment_id: data.assignment_id ? Number(data.assignment_id) : null,
        icon: data.icon ? data.icon : null,
        default_follow: data.default_follow
      });

      toaster.success({
        title: "Success",
        description: "Discussion topic updated successfully"
      });
      handleClose();
      onSuccess();
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to update discussion topic: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  if (!topic) return null;

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="lg">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Edit Discussion Topic</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" colorPalette="red" size="sm">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
            <form onSubmit={handleSubmit(onSubmit)}>
              <Stack spaceY={4}>
                <Field.Root invalid={!!errors.topic}>
                  <Field.Label>Topic Name</Field.Label>
                  <Input
                    {...register("topic", {
                      required: "Topic name is required",
                      minLength: { value: 2, message: "Name must be at least 2 characters" }
                    })}
                    placeholder="e.g., Homework 1, Lab 3, Exam Review"
                  />
                  <Field.ErrorText>{errors.topic?.message}</Field.ErrorText>
                </Field.Root>

                <Field.Root invalid={!!errors.description}>
                  <Field.Label>Description</Field.Label>
                  <Textarea
                    {...register("description", {
                      required: "Description is required"
                    })}
                    placeholder="Describe what this topic is for..."
                    rows={3}
                  />
                  <Field.ErrorText>{errors.description?.message}</Field.ErrorText>
                  <Field.HelperText>
                    A brief description to help students understand when to use this topic
                  </Field.HelperText>
                </Field.Root>

                <Field.Root invalid={!!errors.color}>
                  <Field.Label>Color</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field {...register("color", { required: "Color is required" })}>
                      {TOPIC_COLORS.map((color) => (
                        <option key={color.value} value={color.value}>
                          {color.label}
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Field.ErrorText>{errors.color?.message}</Field.ErrorText>
                  <Field.HelperText>The color used to visually distinguish this topic</Field.HelperText>
                </Field.Root>

                <Controller
                  control={control}
                  name="icon"
                  render={({ field }) => (
                    <TopicIconPicker value={field.value as TopicIconPickerValue} onChange={field.onChange} />
                  )}
                />

                <Controller
                  control={control}
                  name="default_follow"
                  render={({ field }) => (
                    <Field.Root>
                      <Switch checked={!!field.value} onCheckedChange={(e) => field.onChange(e.checked)}>
                        Default follow
                      </Switch>
                      <Field.HelperText>
                        <Text color="fg.muted" fontSize="sm">
                          If enabled, students will automatically follow this topic (they can unfollow later).
                        </Text>
                      </Field.HelperText>
                    </Field.Root>
                  )}
                />

                <Field.Root>
                  <Field.Label>Link to Assignment (Optional)</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field {...register("assignment_id")}>
                      <option value="">No assignment link</option>
                      {assignments.map((assignment) => (
                        <option key={assignment.id} value={assignment.id}>
                          {assignment.title}
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Field.HelperText>
                    Optionally link this topic to a specific assignment for better organization
                  </Field.HelperText>
                </Field.Root>
              </Stack>
            </form>
          </Dialog.Body>

          <Dialog.Footer>
            <HStack justify="end" gap={3}>
              <Button colorPalette="red" onClick={handleClose}>
                Cancel
              </Button>
              <Button colorPalette="green" onClick={handleSubmit(onSubmit)} loading={isSubmitting}>
                Update Topic
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
