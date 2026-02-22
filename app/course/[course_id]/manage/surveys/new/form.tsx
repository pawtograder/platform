"use client";

import { Box, Input, Textarea, Text, HStack, VStack, Button, Heading, Fieldset, Checkbox, NativeSelect } from "@chakra-ui/react";
import { Controller, FieldValues } from "react-hook-form";
import { Button as UIButton } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Radio, RadioGroup } from "@/components/ui/radio";
import { toaster } from "@/components/ui/toaster";
import { UseFormReturnType } from "@refinedev/react-hook-form";
import { useCallback, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { SurveyPreviewModal } from "@/components/survey-preview-modal";
import { SurveyTemplateLibraryModal } from "@/components/survey/SurveyTemplateLibraryModal";
import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogCloseTrigger
} from "@/components/ui/dialog";
import StudentGroupPicker from "@/components/ui/student-group-picker";
import { useAssignments } from "@/hooks/useCourseController";

// New modal wrapper around SurveyBuilder
import SurveyBuilderModal from "@/components/survey/SurveyBuilderModal";
import { createClient } from "@/utils/supabase/client";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type SurveyTemplateInsert = Database["public"]["Tables"]["survey_templates"]["Insert"];

type SurveyFormData = {
  title: string;
  description?: string;
  json: string;
  status: "draft" | "published";
  due_date?: string;
  available_at?: string;
  assignment_id?: number | null;
  allow_response_editing: boolean;
  assigned_to_all: boolean;
  assigned_students?: string[];
};

const sampleJsonTemplate = `{
"pages": [
  {
    "name": "page1",
    "elements": [
      { "type": "text", "name": "question1", "title": "Name" },
      {
        "type": "rating",
        "name": "satisfaction-numeric",
        "title": "How satisfied are you with the course?",
        "description": "Numeric rating scale",
        "rateValues": [1,2,3,4,5,6,7,8,9,10]
      }
    ]
  }
]}`;

export default function SurveyForm({
  form,
  onSubmit,
  saveDraftOnly,
  isEdit = false,
  privateProfileId
}: {
  form: UseFormReturnType<SurveyFormData>;
  onSubmit: (values: FieldValues) => void;
  saveDraftOnly: (values: FieldValues, shouldRedirect?: boolean) => void;
  isEdit?: boolean;
  privateProfileId: string;
}) {
  const {
    handleSubmit,
    register,
    control,
    watch,
    getValues,
    setValue,
    formState: { errors }
  } = form;

  const router = useRouter();
  const { course_id } = useParams();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isScopeModalOpen, setIsScopeModalOpen] = useState(false);

  // Open/close state for the Visual Builder modal
  const [isBuilderOpen, setIsBuilderOpen] = useState(false);
  // Template Library modal state
  const [isTemplateLibraryOpen, setIsTemplateLibraryOpen] = useState(false);
  // Cancel confirmation dialog state
  const [isCancelConfirmOpen, setIsCancelConfirmOpen] = useState(false);
  // Student selector modal state
  const [isStudentSelectorOpen, setIsStudentSelectorOpen] = useState(false);

  const currentJson = watch("json");
  const currentStatus = watch("status");
  const assignedStudents = watch("assigned_students") || [];

  const validateJson = useCallback(() => {
    const jsonValue = getValues("json");
    if (!jsonValue.trim()) {
      toaster.create({
        title: "JSON Validation Failed",
        description: "Please enter JSON configuration",
        type: "error"
      });
      return;
    }
    try {
      JSON.parse(jsonValue);
      toaster.create({
        title: "JSON Valid",
        description: "JSON configuration is valid",
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "JSON Validation Failed",
        description: `Invalid JSON: ${error instanceof Error ? error.message : "Unknown error"}`,
        type: "error"
      });
    }
  }, [getValues]);

  const loadSampleTemplate = useCallback(() => {
    // Open Template Library modal instead of loading hardcoded sample
    setIsTemplateLibraryOpen(true);
  }, []);

  const showPreview = useCallback(() => {
    const jsonValue = getValues("json");
    if (!jsonValue.trim()) {
      toaster.create({
        title: "No Survey Configuration",
        description: "Please enter a JSON configuration before previewing",
        type: "error"
      });
      return;
    }
    try {
      JSON.parse(jsonValue);
      setIsPreviewOpen(true);
    } catch {
      toaster.create({
        title: "Invalid JSON",
        description: "Please fix the JSON configuration before previewing",
        type: "error"
      });
    }
  }, [getValues]);

  const handleCancelClick = useCallback(() => {
    setIsCancelConfirmOpen(true);
  }, []);

  const handleKeepEditing = useCallback(() => {
    setIsCancelConfirmOpen(false);
  }, []);

  const handleDiscard = useCallback(() => {
    setIsCancelConfirmOpen(false);
    router.push(`/course/${course_id}/manage/surveys`);
  }, [router, course_id]);

  const handleAddToTemplate = useCallback(
    async (scope: "course" | "global") => {
      // Run form validation first
      const isValid = await form.trigger();
      if (!isValid) {
        setIsScopeModalOpen(false);
        toaster.error({
          title: "Changes not saved",
          description: "An error occurred while saving the survey. Please try again."
        });
        return;
      }

      setIsScopeModalOpen(false);

      const supabase = createClient();
      const surveyData = {
        title: getValues("title"),
        description: getValues("description") || null,
        json: getValues("json")
      };

      const loadingToast = toaster.create({
        title: "Adding to Template Library",
        description: `Saving as a ${scope} template...`,
        type: "loading"
      });

      try {
        const insertData: SurveyTemplateInsert = {
          id: crypto.randomUUID(),
          title: surveyData.title,
          description: surveyData.description ?? "",
          template: surveyData.json ?? {},
          created_by: privateProfileId,
          scope,
          created_at: new Date().toISOString(),
          class_id: Number(course_id)
        };
        const { error } = await supabase.from("survey_templates").insert(insertData);

        toaster.dismiss(loadingToast);

        if (error) {
          toaster.create({
            title: "Error Adding Template",
            description: error.message,
            type: "error"
          });
        } else {
          toaster.create({
            title: "Template Added",
            description: `"${surveyData.title}" saved as a ${scope} template.`,
            type: "success"
          });
        }
      } catch (err: unknown) {
        console.error("Error adding to template library:", err);
        toaster.dismiss(loadingToast);
        toaster.create({
          title: "Unexpected Error",
          description: "Something went wrong adding the template.",
          type: "error"
        });
      }
    },
    [form, getValues, privateProfileId, course_id]
  );

  const onSubmitWrapper = useCallback(
    async (values: FieldValues) => {
      setIsSubmitting(true);
      try {
        if (values.status === "draft") {
          await saveDraftOnly(values);
        } else {
          await onSubmit(values);
        }
      } catch {
        toaster.error({
          title: "Changes not saved",
          description: "An error occurred while saving the survey. Please try again."
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [onSubmit, saveDraftOnly]
  );

  return (
    <VStack align="center" gap={6} w="100%">
      {/* Back Button and Title */}
      <VStack align="stretch" gap={4} w="100%" maxW="800px">
        <Button
          variant="outline"
          size="sm"
          bg="transparent"
          borderColor="border.emphasized"
          color="fg.muted"
          _hover={{ bg: "gray.subtle" }}
          onClick={handleCancelClick}
          alignSelf="flex-start"
        >
          ← Back to Surveys
        </Button>

        <Heading size="xl" color="fg" textAlign="left">
          {isEdit ? "Edit Survey" : "Create New Survey"}
        </Heading>
      </VStack>

      {/* Main Form Card */}
      <Box w="100%" maxW="800px" bg="bg.muted" border="1px solid" borderColor="border" borderRadius="lg" p={8}>
        <form onSubmit={handleSubmit(onSubmitWrapper)}>
          <Fieldset.Root>
            <VStack align="stretch" gap={6}>
              {/* Survey Title */}
              <Fieldset.Content>
                <Field
                  label="Survey Title"
                  errorText={errors.title?.message?.toString()}
                  invalid={!!errors.title}
                  required
                >
                  <Input
                    placeholder="Enter survey title"
                    bg="bg.subtle"
                    borderColor="border"
                    color="fg"
                    _placeholder={{ color: "fg.subtle" }}
                    _focus={{ borderColor: "blue.solid" }}
                    {...register("title", {
                      required: "Survey title is required",
                      maxLength: {
                        value: 200,
                        message: "Title must be less than 200 characters"
                      }
                    })}
                  />
                </Field>
              </Fieldset.Content>

              {/* Description */}
              <Fieldset.Content>
                <Field label="Description">
                  <Textarea
                    placeholder="Brief description of the survey purpose..."
                    rows={3}
                    bg="bg.subtle"
                    borderColor="border"
                    color="fg"
                    _placeholder={{ color: "fg.subtle" }}
                    _focus={{ borderColor: "blue.solid" }}
                    {...register("description")}
                  />
                </Field>
              </Fieldset.Content>

              {/* Survey JSON Configuration */}
              <Fieldset.Content>
                <Field
                  label="Survey JSON Configuration"
                  errorText={errors.json?.message?.toString()}
                  invalid={!!errors.json}
                  required
                >
                  <Textarea
                    placeholder={sampleJsonTemplate}
                    rows={12}
                    fontFamily="mono"
                    fontSize="sm"
                    bg="bg.subtle"
                    borderColor="border"
                    color="fg"
                    _placeholder={{ color: "fg.subtle" }}
                    _focus={{ borderColor: "blue.solid" }}
                    {...register("json", {
                      required: "JSON configuration is required",
                      validate: (value) => {
                        if (!value.trim()) return "JSON configuration is required";
                        try {
                          JSON.parse(value);
                          return true;
                        } catch {
                          return "Invalid JSON format";
                        }
                      }
                    })}
                  />

                  <HStack justify="space-between" mt={2}>
                    {/* Open the modal popup builder */}
                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor="border.emphasized"
                      color="fg.muted"
                      _hover={{ bg: "gray.subtle" }}
                      onClick={() => setIsBuilderOpen(true)}
                    >
                      Open Visual Builder
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor="border.emphasized"
                      color="fg.muted"
                      _hover={{ bg: "gray.subtle" }}
                      onClick={loadSampleTemplate}
                    >
                      Load Template
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor="border.emphasized"
                      color="fg.muted"
                      _hover={{ bg: "gray.subtle" }}
                      onClick={validateJson}
                    >
                      Validate JSON
                    </Button>
                  </HStack>
                </Field>
              </Fieldset.Content>

              {/* Status */}
              <Fieldset.Content>
                <Field label="Status" errorText={errors.status?.message?.toString()} invalid={!!errors.status} required>
                  <Controller
                    name="status"
                    control={control}
                    rules={{ required: "Status is required" }}
                    render={({ field }) => (
                      <RadioGroup
                        value={field.value}
                        onValueChange={(e) => field.onChange(e.value)}
                        colorPalette="blue"
                      >
                        <VStack align="start" gap={2}>
                          <Radio value="draft">
                            <Text color="fg">Save as Draft</Text>
                          </Radio>
                          <Radio value="published">
                            <Text color="fg">Publish Now</Text>
                          </Radio>
                        </VStack>
                      </RadioGroup>
                    )}
                  />
                </Field>
              </Fieldset.Content>

              {/* Link to Assignment */}
              <Fieldset.Content>
                <Field label="Link to Assignment" helperText="Optionally link this survey to an assignment. Students will see the survey status on their submission page.">
                  <Controller
                    name="assignment_id"
                    control={control}
                    render={({ field }) => {
                      const assignments = useAssignments();
                      return (
                        <NativeSelect.Root size="sm">
                          <NativeSelect.Field
                            value={field.value ?? ""}
                            onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)}
                            bg="bg.subtle"
                            borderColor="border"
                            color="fg"
                          >
                            <option value="">No linked assignment</option>
                            {assignments.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.title}
                              </option>
                            ))}
                          </NativeSelect.Field>
                        </NativeSelect.Root>
                      );
                    }}
                  />
                </Field>
              </Fieldset.Content>

              {/* Available At */}
              <Fieldset.Content>
                <Field label="Available At" helperText="When the survey becomes visible to students. Leave empty to make it available immediately upon publishing.">
                  <Controller
                    name="available_at"
                    control={control}
                    render={({ field }) => (
                      <Input
                        type="datetime-local"
                        value={field.value || ""}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        bg="bg.subtle"
                        borderColor="border"
                        color="fg"
                        _focus={{ borderColor: "blue.solid" }}
                      />
                    )}
                  />
                </Field>
              </Fieldset.Content>

              {/* Due Date */}
              <Fieldset.Content>
                <Field label="Due Date">
                  <Controller
                    name="due_date"
                    control={control}
                    render={({ field }) => (
                      <Input
                        type="datetime-local"
                        value={field.value || ""}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        bg="bg.subtle"
                        borderColor="border"
                        color="fg"
                        _focus={{ borderColor: "blue.solid" }}
                      />
                    )}
                  />
                </Field>
              </Fieldset.Content>

              {/* Allow Response Editing */}
              <Fieldset.Content>
                <Controller
                  name="allow_response_editing"
                  control={control}
                  render={({ field }) => (
                    <HStack gap={3} align="center">
                      <Box position="relative">
                        <Box
                          position="absolute"
                          top="0"
                          left="0"
                          w="5"
                          h="5"
                          bg="bg"
                          border="1px solid"
                          borderColor="border"
                          borderRadius="xs"
                          zIndex="0"
                        />
                        <Checkbox.Root
                          checked={field.value}
                          onCheckedChange={(details) => field.onChange(details.checked)}
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control />
                        </Checkbox.Root>
                      </Box>
                      <Text color="fg">Allow students to edit their responses after submission</Text>
                    </HStack>
                  )}
                />
              </Fieldset.Content>

              {/* Assignment Mode */}
              <Fieldset.Content>
                <Field label="Assignment" required>
                  <Controller
                    name="assigned_to_all"
                    control={control}
                    defaultValue={true}
                    render={({ field }) => (
                      <VStack align="start" gap={3}>
                        <RadioGroup
                          value={field.value ? "all" : "specific"}
                          onValueChange={(e) => field.onChange(e.value === "all")}
                          colorPalette="blue"
                        >
                          <VStack align="start" gap={2}>
                            <Radio value="all">
                              <Text color="fg">Assign to all students in the course</Text>
                            </Radio>
                            <Radio value="specific">
                              <Text color="fg">Assign to specific students</Text>
                            </Radio>
                          </VStack>
                        </RadioGroup>

                        {field.value === false && (
                          <Box w="100%" mt={2}>
                            <Button
                              size="sm"
                              variant="outline"
                              bg="transparent"
                              borderColor="border.emphasized"
                              color="fg.muted"
                              _hover={{ bg: "gray.subtle" }}
                              onClick={() => setIsStudentSelectorOpen(true)}
                            >
                              Select Students ({assignedStudents.length} selected)
                            </Button>
                            {assignedStudents.length > 0 && (
                              <Text fontSize="sm" color="fg.subtle" mt={2}>
                                {assignedStudents.length} student{assignedStudents.length !== 1 ? "s" : ""} selected
                              </Text>
                            )}
                          </Box>
                        )}
                      </VStack>
                    )}
                  />
                </Field>
              </Fieldset.Content>

              {/* Preview Section */}
              <VStack align="stretch" gap={2}>
                <Text color="fg" fontWeight="medium">
                  Preview
                </Text>
                <Box p={8} bg="bg.subtle" borderRadius="md" textAlign="center" border="1px solid" borderColor="border">
                  <Text color="fg.subtle" mb={4}>
                    Click &apos;Show Preview&apos; to see how the survey will appear to students.
                  </Text>
                  <Button
                    variant="outline"
                    bg="transparent"
                    borderColor="border.emphasized"
                    color="fg.muted"
                    _hover={{ bg: "green.subtle" }}
                    onClick={showPreview}
                  >
                    Show Preview
                  </Button>
                </Box>
              </VStack>

              {/* Action Buttons */}
              <HStack gap={4} justify="flex-start" pt={4}>
                <UIButton
                  type="submit"
                  loading={isSubmitting}
                  size="md"
                  colorPalette={currentStatus === "published" ? "green" : "blue"}
                  bg={currentStatus === "published" ? "green.solid" : "blue.solid"}
                  color="white"
                  _hover={{ bg: currentStatus === "published" ? "green.emphasized" : "blue.emphasized" }}
                >
                  {currentStatus === "published" ? "Publish Survey" : "Save Draft"}
                </UIButton>
                <Button
                  variant="outline"
                  borderColor="border.emphasized"
                  color="fg.muted"
                  _hover={{ bg: "gray.subtle" }}
                  onClick={async () => {
                    const isValid = await form.trigger();
                    if (isValid) {
                      setIsScopeModalOpen(true);
                    } else {
                      toaster.error({
                        title: "Changes not saved",
                        description: "An error occurred while saving the survey. Please try again."
                      });
                    }
                  }}
                  size="md"
                >
                  Add to Template Library
                </Button>
                <Button
                  variant="outline"
                  bg="transparent"
                  borderColor="border.emphasized"
                  color="fg.muted"
                  _hover={{ bg: "gray.subtle" }}
                  onClick={handleCancelClick}
                  size="md"
                >
                  Cancel
                </Button>
              </HStack>
            </VStack>
          </Fieldset.Root>
        </form>
      </Box>

      {/* Choose Template Scope Modal */}
      {isScopeModalOpen && (
        <Box
          position="fixed"
          top="0"
          left="0"
          w="100vw"
          h="100vh"
          bg="blackAlpha.500"
          zIndex={9999}
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          <Box
            bg="bg.muted"
            p={8}
            borderRadius="lg"
            border="1px solid"
            borderColor="border"
            maxW="400px"
            textAlign="center"
          >
            <Text fontSize="lg" fontWeight="semibold" mb={2} color="fg">
              Save Template Scope
            </Text>
            <Text mb={6} color="fg.subtle">
              Do you want to save this template for this course only or share it with all instructors?
            </Text>
            <HStack justify="center" gap={3}>
              <Button
                colorPalette="green"
                bg="green.solid"
                color="white"
                _hover={{ bg: "green.emphasized" }}
                onClick={() => handleAddToTemplate("course")}
              >
                Course Only
              </Button>
              <Button
                colorPalette="blue"
                bg="blue.solid"
                color="white"
                _hover={{ bg: "blue.emphasized" }}
                onClick={() => handleAddToTemplate("global")}
              >
                Global
              </Button>
              <Button
                variant="outline"
                borderColor="border.emphasized"
                color="fg.muted"
                _hover={{ bg: "gray.subtle" }}
                onClick={() => setIsScopeModalOpen(false)}
              >
                Cancel
              </Button>
            </HStack>
          </Box>
        </Box>
      )}

      {/* Visual Builder Modal (popup) */}
      <SurveyBuilderModal
        key={currentJson}
        isOpen={isBuilderOpen}
        onClose={() => setIsBuilderOpen(false)}
        initialJson={currentJson}
        onSave={(json) => setValue("json", json, { shouldDirty: true, shouldValidate: true })}
      />

      {/* Survey Preview Modal */}
      <SurveyPreviewModal
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        surveyJson={watch("json")}
        surveyTitle={watch("title")}
      />

      {/* Template Library Modal */}
      <SurveyTemplateLibraryModal
        isOpen={isTemplateLibraryOpen}
        onClose={() => setIsTemplateLibraryOpen(false)}
        courseId={course_id as string}
        isEditMode={isEdit}
        onTemplateLoad={(templateJson, templateTitle, templateDescription) => {
          setValue("json", templateJson, { shouldDirty: true });
          if (templateTitle && !getValues("title")) {
            setValue("title", templateTitle, { shouldDirty: true });
          }
          if (templateDescription && !getValues("description")) {
            setValue("description", templateDescription, { shouldDirty: true });
          }
          toaster.create({
            title: "Template Loaded",
            description: "Template has been loaded into this survey.",
            type: "success"
          });
        }}
      />

      <DialogRoot open={isCancelConfirmOpen} onOpenChange={(e) => setIsCancelConfirmOpen(e.open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Cancel Survey Editing" : "Cancel Survey Creation"}</DialogTitle>
            <DialogCloseTrigger />
          </DialogHeader>
          <DialogBody>
            <Text color="fg">Are you sure you want to cancel? Any unsaved changes will be lost.</Text>
          </DialogBody>
          <DialogFooter>
            <HStack gap={3} justify="flex-end">
              <Button
                variant="outline"
                borderColor="border.emphasized"
                color="fg.muted"
                _hover={{ bg: "gray.subtle" }}
                onClick={handleKeepEditing}
              >
                Keep Editing
              </Button>
              <Button
                colorPalette="red"
                bg="red.solid"
                color="white"
                _hover={{ bg: "red.emphasized" }}
                onClick={handleDiscard}
              >
                Discard
              </Button>
            </HStack>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>

      {/* Student Selector Modal */}
      <DialogRoot open={isStudentSelectorOpen} onOpenChange={(e) => setIsStudentSelectorOpen(e.open)}>
        <DialogContent maxW="600px">
          <DialogHeader>
            <DialogTitle>Select Students</DialogTitle>
            <DialogCloseTrigger />
          </DialogHeader>
          <DialogBody>
            <VStack align="stretch" gap={4}>
              <Text color="fg" fontSize="sm">
                Choose which students should have access to this survey. You can search by name and select multiple
                students.
              </Text>
              <StudentGroupPicker
                selectedStudents={assignedStudents}
                onSelectionChange={(students) => setValue("assigned_students", students)}
                placeholder="Search and select students..."
                label="Students"
                helperText="Select students who should see this survey"
              />
            </VStack>
          </DialogBody>
          <DialogFooter>
            <HStack gap={3} justify="flex-end">
              <Button
                variant="outline"
                borderColor="border.emphasized"
                color="fg.muted"
                _hover={{ bg: "gray.subtle" }}
                onClick={() => setIsStudentSelectorOpen(false)}
              >
                Cancel
              </Button>
              <Button
                colorPalette="green"
                bg="green.solid"
                color="white"
                _hover={{ bg: "green.emphasized" }}
                onClick={() => setIsStudentSelectorOpen(false)}
                disabled={assignedStudents.length === 0}
              >
                Confirm ({assignedStudents.length} selected)
              </Button>
            </HStack>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    </VStack>
  );
}
