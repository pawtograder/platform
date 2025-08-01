"use client";

import { Box, Dialog, Field, HStack, Icon, Input, Stack, NativeSelect, Textarea } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { useParams } from "next/navigation";
import { BsX } from "react-icons/bs";
import useAuthState from "@/hooks/useAuthState";
import { useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import { toaster } from "@/components/ui/toaster";

type HelpRequestTemplateFormData = {
  name: string;
  description: string | null;
  category: string;
  template_content: string;
  is_active: boolean;
};

type CreateHelpRequestTemplateModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

/**
 * Modal component for creating new help request templates.
 * Allows instructors and graders to create templates that students can use
 * when submitting help requests.
 */
export default function CreateHelpRequestTemplateModal({
  isOpen,
  onClose,
  onSuccess
}: CreateHelpRequestTemplateModalProps) {
  const { course_id } = useParams();
  const { user } = useAuthState();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<HelpRequestTemplateFormData>({
    defaultValues: {
      name: "",
      description: "",
      category: "General",
      template_content: "",
      is_active: true
    }
  });

  // Get table controllers from office hours controller
  const controller = useOfficeHoursController();
  const { helpRequestTemplates } = controller;

  const handleClose = () => {
    reset();
    onClose();
  };

  const onSubmit = async (data: HelpRequestTemplateFormData) => {
    if (!user?.id) {
      toaster.error({
        title: "Error",
        description: "You must be logged in to create templates"
      });
      return;
    }

    try {
      await helpRequestTemplates.create({
        class_id: Number(course_id),
        name: data.name,
        description: data.description || null,
        category: data.category,
        template_content: data.template_content,
        is_active: data.is_active,
        created_by_id: user.id,
        usage_count: 0
      });
      
      toaster.success({
        title: "Success",
        description: "Help request template created successfully"
      });
      handleClose();
      onSuccess();
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to create template: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  // Common template categories
  const templateCategories = [
    "General",
    "Assignment Help",
    "Technical Issues",
    "Grading Questions",
    "Lab Support",
    "Project Help",
    "Debugging",
    "Conceptual Questions",
    "Office Hours",
    "Other"
  ];

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="lg">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Create New Help Request Template</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" colorPalette="red" size="sm">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
            <form onSubmit={handleSubmit(onSubmit)}>
              <Stack spaceY={4}>
                <Field.Root invalid={!!errors.name}>
                  <Field.Label>Template Name</Field.Label>
                  <Input
                    {...register("name", {
                      required: "Template name is required",
                      minLength: { value: 2, message: "Name must be at least 2 characters" }
                    })}
                    placeholder="e.g., Debugging Help Request, Assignment Question"
                  />
                  <Field.ErrorText>{errors.name?.message}</Field.ErrorText>
                </Field.Root>

                <Field.Root>
                  <Field.Label>Description</Field.Label>
                  <Input {...register("description")} placeholder="Brief description of when to use this template..." />
                  <Field.HelperText>
                    Optional description to help students understand when to use this template
                  </Field.HelperText>
                </Field.Root>

                <Field.Root invalid={!!errors.category}>
                  <Field.Label>Category</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field {...register("category", { required: "Category is required" })}>
                      {templateCategories.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                  <Field.ErrorText>{errors.category?.message}</Field.ErrorText>
                  <Field.HelperText>Categorize this template to help with organization</Field.HelperText>
                </Field.Root>

                <Field.Root invalid={!!errors.template_content}>
                  <Field.Label>Template Content</Field.Label>
                  <Textarea
                    {...register("template_content", {
                      required: "Template content is required",
                      minLength: { value: 10, message: "Template content must be at least 10 characters" }
                    })}
                    placeholder="**What I'm working on:**
[Describe the assignment/task you're working on]

**What I've tried:**
[List the steps you've already taken to solve the problem]

**The specific problem:**
[Describe exactly what isn't working or what you're confused about]

**Error messages (if any):**
[Copy and paste any error messages you're seeing]

**Questions:**
[What specific help do you need?]"
                    rows={12}
                  />
                  <Field.ErrorText>{errors.template_content?.message}</Field.ErrorText>
                  <Field.HelperText>
                    The template content that students will see. Use markdown formatting for better structure.
                  </Field.HelperText>
                </Field.Root>

                <Box>
                  <Field.Root>
                    <Field.Label>
                      <input type="checkbox" {...register("is_active")} style={{ marginRight: "8px" }} />
                      Template is active
                    </Field.Label>
                    <Field.HelperText>
                      Active templates are visible to students when creating help requests
                    </Field.HelperText>
                  </Field.Root>
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
                Create Template
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
