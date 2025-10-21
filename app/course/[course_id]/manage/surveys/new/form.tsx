"use client";

import { Box, Input, Textarea, Text, HStack, VStack, Button, Heading, Fieldset, Checkbox } from "@chakra-ui/react";
import { Controller, FieldValues } from "react-hook-form";
import { Button as UIButton } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { UseFormReturnType } from "@refinedev/react-hook-form";
import { useCallback, useState } from "react";
import { LuCheck } from "react-icons/lu";
import { useRouter } from "next/navigation";
import { useParams } from "next/navigation";
import { useColorModeValue } from "@/components/ui/color-mode";

type SurveyFormData = {
  title: string;
  description?: string;
  json: string;
  status: "draft" | "published";
  due_date?: string;
  allow_response_editing: boolean;
};

const sampleJsonTemplate = `{
  "pages": [{
    "name": "page1",
    "elements": [{
      "type": "rating",
      "name": "satisfaction",
      "title": "How satisfied are you with the course?",
      "rateDescription": {"1": "Not Satisfied", "5": "Very Satisfied"}
    }]
  }]
}`;

export default function SurveyForm({
  form,
  onSubmit,
  saveDraftOnly
}: {
  form: UseFormReturnType<SurveyFormData>;
  onSubmit: (values: FieldValues) => void;
  saveDraftOnly: (values: FieldValues) => void;
}) {
  // Color mode values where the first values correspond as follows:
  // useColorModeValue(lightModeValue, darkModeValue)
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#F2F2F2", "#0D0D0D");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const placeholderColor = useColorModeValue("#8A8A8A", "#757575");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const checkboxBgColor = useColorModeValue("#FFFFFF", "#1A1A1A");
  const checkboxBorderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const checkboxIconColor = useColorModeValue("#000000", "#FFFFFF");
  const previewButtonTextColor = useColorModeValue("#2D3748", "#A0AEC0");
  const previewButtonBorderColor = useColorModeValue("#4A5568", "#4A5568");

  const {
    handleSubmit,
    register,
    control,
    watch,
    getValues,
    setValue,
    formState: { errors, isDirty }
  } = form;

  const router = useRouter();
  const { course_id } = useParams();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const status = watch("status");

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
    setValue("json", sampleJsonTemplate, { shouldDirty: true });
    toaster.create({
      title: "Sample Template Loaded",
      description: "Sample JSON template has been loaded",
      type: "success"
    });
  }, [setValue]);

  const showPreview = useCallback(() => {
    // Placeholder for now - will open in new tab
    toaster.create({
      title: "Preview Feature",
      description: "Preview functionality will be implemented soon",
      type: "info"
    });
  }, []);

  const handleBackNavigation = useCallback(async () => {
    if (isDirty) {
      // Auto-save as draft before navigating - no validation
      const currentValues = getValues();

      try {
        await saveDraftOnly(currentValues);
        toaster.create({
          title: "Draft Saved",
          description: "Your changes have been saved as a draft",
          type: "success"
        });
      } catch (error) {
        console.error("Back navigation draft save error:", error);
        toaster.create({
          title: "Failed to Save Draft",
          description: error instanceof Error ? error.message : "Could not save draft before navigating",
          type: "error"
        });
        // Still navigate even if save failed - user can start over
        // return; // Don't navigate if save failed
      }
    }

    router.push(`/course/${course_id}/manage/surveys`);
  }, [isDirty, getValues, saveDraftOnly, router, course_id]);

  const onSubmitWrapper = useCallback(
    async (values: FieldValues) => {
      setIsSubmitting(true);
      try {
        // Check if user selected "Save as Draft" - use saveDraftOnly for no validation
        if (values.status === "draft") {
          await saveDraftOnly(values);
        } else {
          // User selected "Publish Now" - use full validation
          await onSubmit(values);
        }
      } catch (error) {
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
          onClick={() => router.push(`/course/${course_id}/manage/surveys`)}
          alignSelf="flex-start"
        >
          ← Back to Surveys
        </Button>

        {/* Header */}
        <Heading size="xl" color={textColor} textAlign="left">
          Create New Survey
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
                  invalid={errors.title ? true : false}
                  required={true}
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
                      maxLength: { value: 200, message: "Title must be less than 200 characters" }
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
                  invalid={errors.json ? true : false}
                  required={true}
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
                        } catch (error) {
                          return "Invalid JSON format";
                        }
                      }
                    })}
                  />
                  <HStack justify="space-between" mt={2}>
                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor={buttonBorderColor}
                      color={buttonTextColor}
                      _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                      onClick={loadSampleTemplate}
                    >
                      Load Sample Template
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
                <Field
                  label="Status"
                  errorText={errors.status?.message?.toString()}
                  invalid={errors.status ? true : false}
                  required={true}
                >
                  <Controller
                    name="status"
                    control={control}
                    defaultValue="draft"
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
                    <Checkbox.Root {...register("allow_response_editing")}>
                      <Checkbox.HiddenInput />
                      <Checkbox.Control></Checkbox.Control>
                    </Checkbox.Root>
                  </Box>
                  <Text color={textColor}>Allow students to edit their responses after submission</Text>
                </HStack>
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
                    Click 'Show Preview' to see how the survey will appear to students.
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
                  bg="#22C55E"
                  color="white"
                  _hover={{ bg: "#16A34A" }}
                >
                  Save Survey
                </UIButton>
                <Button
                  variant="outline"
                  bg="transparent"
                  borderColor={buttonBorderColor}
                  color={buttonTextColor}
                  _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                  onClick={handleBackNavigation}
                  size="md"
                >
                  Cancel
                </Button>
              </HStack>
            </VStack>
          </Fieldset.Root>
        </form>
      </Box>
    </VStack>
  );
}
