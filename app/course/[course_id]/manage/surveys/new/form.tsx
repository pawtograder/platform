"use client";

import { Box, Input, Textarea, Text, HStack, VStack, Button, Heading, Fieldset, Checkbox } from "@chakra-ui/react";
import { Controller, FieldValues } from "react-hook-form";
import { Button as UIButton } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { UseFormReturnType } from "@refinedev/react-hook-form";
import { useCallback, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { useColorModeValue } from "@/components/ui/color-mode";
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

// NEW: modal wrapper around your SurveyBuilder
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
  // Color tokens
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#F2F2F2", "#0D0D0D");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const placeholderColor = useColorModeValue("#8A8A8A", "#757575");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const checkboxBgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
  const checkboxBorderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const previewButtonTextColor = useColorModeValue("#2D3748", "#A0AEC0");
  const previewButtonBorderColor = useColorModeValue("#4A5568", "#4A5568");

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

  // NEW: open/close state for the Visual Builder modal
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
          borderColor={buttonBorderColor}
          color={buttonTextColor}
          _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
          onClick={handleCancelClick}
          alignSelf="flex-start"
        >
          ← Back to Surveys
        </Button>

        <Heading size="xl" color={textColor} textAlign="left">
          {isEdit ? "Edit Survey" : "Create New Survey"}
        </Heading>
      </VStack>

      {/* Main Form Card */}
      <Box w="100%" maxW="800px" bg={cardBgColor} border="1px solid" borderColor={borderColor} borderRadius="lg" p={8}>
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
                    bg={bgColor}
                    borderColor={borderColor}
                    color={textColor}
                    _placeholder={{ color: placeholderColor }}
                    _focus={{ borderColor: "blue.500" }}
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
                    bg={bgColor}
                    borderColor={borderColor}
                    color={textColor}
                    _placeholder={{ color: placeholderColor }}
                    _focus={{ borderColor: "blue.500" }}
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
                    bg={bgColor}
                    borderColor={borderColor}
                    color={textColor}
                    _placeholder={{ color: placeholderColor }}
                    _focus={{ borderColor: "blue.500" }}
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
                      borderColor={buttonBorderColor}
                      color={buttonTextColor}
                      _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                      onClick={() => setIsBuilderOpen(true)}
                    >
                      Open Visual Builder
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor={buttonBorderColor}
                      color={buttonTextColor}
                      _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                      onClick={loadSampleTemplate}
                    >
                      Load Template
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor={buttonBorderColor}
                      color={buttonTextColor}
                      _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
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
                      <VStack align="start" gap={2}>
                        <HStack>
                          <input
                            type="radio"
                            id="draft"
                            value="draft"
                            checked={field.value === "draft"}
                            onChange={() => field.onChange("draft")}
                            style={{ accentColor: "#3182ce" }}
                          />
                          <label htmlFor="draft" style={{ color: textColor, cursor: "pointer" }}>
                            Save as Draft
                          </label>
                        </HStack>
                        <HStack>
                          <input
                            type="radio"
                            id="published"
                            value="published"
                            checked={field.value === "published"}
                            onChange={() => field.onChange("published")}
                            style={{ accentColor: "#3182ce" }}
                          />
                          <label htmlFor="published" style={{ color: textColor, cursor: "pointer" }}>
                            Publish Now
                          </label>
                        </HStack>
                      </VStack>
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
                        bg={bgColor}
                        borderColor={borderColor}
                        color={textColor}
                        _focus={{ borderColor: "blue.500" }}
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
                          bg={checkboxBgColor}
                          border="1px solid"
                          borderColor={checkboxBorderColor}
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
                      <Text color={textColor}>Allow students to edit their responses after submission</Text>
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
                        <HStack>
                          <input
                            type="radio"
                            id="assign_all"
                            checked={field.value === true}
                            onChange={() => {
                              field.onChange(true);
                              // Keep assigned_students in form state so user can switch back
                            }}
                            style={{ accentColor: "#3182ce" }}
                          />
                          <label htmlFor="assign_all" style={{ color: textColor, cursor: "pointer" }}>
                            Assign to all students in the course
                          </label>
                        </HStack>
                        <HStack>
                          <input
                            type="radio"
                            id="assign_specific"
                            checked={field.value === false}
                            onChange={() => field.onChange(false)}
                            style={{ accentColor: "#3182ce" }}
                          />
                          <label htmlFor="assign_specific" style={{ color: textColor, cursor: "pointer" }}>
                            Assign to specific students
                          </label>
                        </HStack>

                        {field.value === false && (
                          <Box w="100%" mt={2}>
                            <Button
                              size="sm"
                              variant="outline"
                              bg="transparent"
                              borderColor={buttonBorderColor}
                              color={buttonTextColor}
                              _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                              onClick={() => setIsStudentSelectorOpen(true)}
                            >
                              Select Students ({assignedStudents.length} selected)
                            </Button>
                            {assignedStudents.length > 0 && (
                              <Text fontSize="sm" color={placeholderColor} mt={2}>
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
                <Text color={textColor} fontWeight="medium">
                  Preview
                </Text>
                <Box
                  p={8}
                  bg={bgColor}
                  borderRadius="md"
                  textAlign="center"
                  border="1px solid"
                  borderColor={borderColor}
                >
                  <Text color={placeholderColor} mb={4}>
                    Click &apos;Show Preview&apos; to see how the survey will appear to students.
                  </Text>
                  <Button
                    variant="outline"
                    bg="transparent"
                    borderColor={previewButtonBorderColor}
                    color={previewButtonTextColor}
                    _hover={{ bg: "rgba(34, 197, 94, 0.1)" }}
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
                  bg={currentStatus === "published" ? "#22C55E" : "#3182ce"}
                  color="white"
                  _hover={{ bg: currentStatus === "published" ? "#16A34A" : "#2b6cb0" }}
                >
                  {currentStatus === "published" ? "Publish Survey" : "Save Draft"}
                </UIButton>
                <Button
                  variant="outline"
                  borderColor={buttonBorderColor}
                  color={buttonTextColor}
                  _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
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
                  borderColor={buttonBorderColor}
                  color={buttonTextColor}
                  _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
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
          bg="rgba(0,0,0,0.5)"
          zIndex={9999}
          display="flex"
          alignItems="center"
          justifyContent="center"
        >
          <Box
            bg={cardBgColor}
            p={8}
            borderRadius="lg"
            border="1px solid"
            borderColor={borderColor}
            maxW="400px"
            textAlign="center"
          >
            <Text fontSize="lg" fontWeight="semibold" mb={2} color={textColor}>
              Save Template Scope
            </Text>
            <Text mb={6} color={placeholderColor}>
              Do you want to save this template for this course only or share it with all instructors?
            </Text>
            <HStack justify="center" gap={3}>
              <Button
                bg="#22C55E"
                color="white"
                _hover={{ bg: "#16A34A" }}
                onClick={() => handleAddToTemplate("course")}
              >
                Course Only
              </Button>
              <Button
                bg="#3B82F6"
                color="white"
                _hover={{ bg: "#2563EB" }}
                onClick={() => handleAddToTemplate("global")}
              >
                Global
              </Button>
              <Button
                variant="outline"
                borderColor={buttonBorderColor}
                color={buttonTextColor}
                _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
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
            <Text color={textColor}>Are you sure you want to cancel? Any unsaved changes will be lost.</Text>
          </DialogBody>
          <DialogFooter>
            <HStack gap={3} justify="flex-end">
              <Button
                variant="outline"
                borderColor={buttonBorderColor}
                color={buttonTextColor}
                _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                onClick={handleKeepEditing}
              >
                Keep Editing
              </Button>
              <Button bg="#EF4444" color="white" _hover={{ bg: "#DC2626" }} onClick={handleDiscard}>
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
              <Text color={textColor} fontSize="sm">
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
                borderColor={buttonBorderColor}
                color={buttonTextColor}
                _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                onClick={() => setIsStudentSelectorOpen(false)}
              >
                Cancel
              </Button>
              <Button
                bg="#22C55E"
                color="white"
                _hover={{ bg: "#16A34A" }}
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
