"use client";

import {
  Box,
  Input,
  Textarea,
  Text,
  HStack,
  VStack,
  Button,
  Heading,
  Checkbox
} from "@chakra-ui/react";
import { useForm, Controller } from "react-hook-form";
import { useParams, useRouter } from "next/navigation";
import { useColorModeValue } from "@/components/ui/color-mode";
import { Field } from "@/components/ui/field";
import { Button as UIButton } from "@/components/ui/button";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";
import { useCallback, useState } from "react";
import PollBuilderModal from "@/components/PollBuilderModal";
import { PollPreviewModal } from "@/components/PollPreviewModal";

type PollFormValues = {
  question: string;
  allowMultipleResponses: boolean;
};

const samplePollTemplate = `{
  "prompt": "Which topic should we review next?",
  "type": "multiple-choice",
  "choices": [
    { "id": "recursion", "label": "Recursion" },
    { "id": "dynamic-programming", "label": "Dynamic Programming" },
    { "id": "graphs", "label": "Graphs" }
  ]
}`;

export default function NewPollPage() {
  const { course_id } = useParams();
  const router = useRouter();
  const { public_profile_id } = useClassProfiles();
  const [isSaving, setIsSaving] = useState(false);
  const [isBuilderOpen, setIsBuilderOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    getValues,
    setValue,
    watch
  } = useForm<PollFormValues>({
    defaultValues: {
      question: samplePollTemplate,
      allowMultipleResponses: false
    }
  });

  const questionValue = watch("question");

  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const bgColor = useColorModeValue("#F2F2F2", "#0D0D0D");
  const borderColor = useColorModeValue("#D2D2D", "#2D2D2D");
  const placeholderColor = useColorModeValue("#8A8A8A", "#757575");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");

  const validateJson = useCallback(() => {
    const jsonValue = getValues("question");
    if (!jsonValue.trim()) {
      toaster.create({
        title: "Missing question",
        description: "Please enter a JSON payload for your poll question.",
        type: "error"
      });
      return;
    }
    try {
      const parsed = JSON.parse(jsonValue);
      
      // Ensure it's a single question object, not an array
      if (Array.isArray(parsed)) {
        toaster.create({
          title: "Invalid Question Format",
          description: "Polls can only contain a single question. Please provide a single question object, not an array.",
          type: "error"
        });
        return;
      }
      
      // Ensure it has required fields
      if (typeof parsed !== "object" || parsed === null || !parsed.prompt || !parsed.type) {
        toaster.create({
          title: "Invalid Question Format",
          description: "Question must be an object with 'prompt' and 'type' fields.",
          type: "error"
        });
        return;
      }
      
      toaster.create({
        title: "JSON valid",
        description: "Your poll question JSON looks good.",
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Invalid JSON",
        description: error instanceof Error ? error.message : "Unable to parse the JSON payload.",
        type: "error"
      });
    }
  }, [getValues]);

  const loadSampleTemplate = useCallback(() => {
    setValue("question", samplePollTemplate, { shouldDirty: true });
    toaster.create({
      title: "Sample loaded",
      description: "You can customize the template to match your poll.",
      type: "info"
    });
  }, [setValue]);

  const handleBuilderSave = useCallback((json: string) => {
    setValue("question", json, { shouldDirty: true });
    toaster.create({
      title: "Poll question updated",
      description: "Your poll question has been updated from the visual builder.",
      type: "success"
    });
  }, [setValue]);

  const showPreview = useCallback(() => {
    const jsonValue = getValues("question");
    if (!jsonValue.trim()) {
      toaster.create({
        title: "No Poll Question",
        description: "Please enter a poll question JSON before previewing",
        type: "error"
      });
      return;
    }
    try {
      const parsed = JSON.parse(jsonValue);
      
      // Ensure it's a single question object, not an array
      if (Array.isArray(parsed)) {
        toaster.create({
          title: "Invalid Question Format",
          description: "Polls can only contain a single question. Please provide a single question object, not an array.",
          type: "error"
        });
        return;
      }
      
      // Ensure it has required fields
      if (typeof parsed !== "object" || parsed === null || !parsed.prompt || !parsed.type) {
        toaster.create({
          title: "Invalid Question Format",
          description: "Question must be an object with 'prompt' and 'type' fields.",
          type: "error"
        });
        return;
      }
      
      setIsPreviewOpen(true);
    } catch {
      toaster.create({
        title: "Invalid JSON",
        description: "Please fix the JSON configuration before previewing",
        type: "error"
      });
    }
  }, [getValues]);

  const savePoll = useCallback(
    async (values: PollFormValues, publish: boolean = false) => {
      if (!course_id) {
        toaster.create({
          title: "Missing course",
          description: "We could not determine which course you're in.",
          type: "error"
        });
        return;
      }

      if (!public_profile_id) {
        toaster.create({
          title: "Profile not found",
          description: "We could not find your instructor profile for this course.",
          type: "error"
        });
        return;
      }

      let parsedQuestion: Record<string, unknown>;
      try {
        const parsed = JSON.parse(values.question);
        
        // Ensure it's a single question object, not an array
        if (Array.isArray(parsed)) {
          toaster.create({
            title: "Invalid Question Format",
            description: "Polls can only contain a single question. Please provide a single question object, not an array.",
            type: "error"
          });
          return;
        }
        
        // Ensure it has required fields for a single question
        if (typeof parsed !== "object" || parsed === null || !parsed.prompt || !parsed.type) {
          toaster.create({
            title: "Invalid Question Format",
            description: "Question must be an object with 'prompt' and 'type' fields.",
            type: "error"
          });
          return;
        }
        
        parsedQuestion = parsed;
        // Add allowMultipleResponses to the question JSON
        parsedQuestion.allowMultipleResponses = values.allowMultipleResponses;
      } catch (error) {
        toaster.create({
          title: "Invalid JSON",
          description: error instanceof Error ? error.message : "Unable to parse the JSON payload.",
          type: "error"
        });
        return;
      }

      setIsSaving(true);
      const supabase = createClient();

      try {
        const isLive = publish;

        // If publishing, set deactivates_at to 1 hour from now
        const deactivatesAt = isLive 
          ? new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour from now
          : null;

        const { error } = await supabase
          .from("live_polls" as any)
          .insert({
            class_id: Number(course_id),
            created_by: public_profile_id,
            question: parsedQuestion,
            is_live: isLive,
            deactivates_at: deactivatesAt
          })
          .select("id")
          .single();

        if (error) {
          throw new Error(error.message);
        }

        if (publish) {
          toaster.create({
            title: "Poll published",
            description: "Your poll has been published and is now live for students.",
            type: "success"
          });
        } else {
          toaster.create({
            title: "Draft saved",
            description: "Your poll has been saved as a draft.",
            type: "success"
          });
        }

        router.push(`/course/${course_id}/manage/polls`);
      } catch (error) {
        toaster.create({
          title: "Unable to save poll",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
          type: "error"
        });
      } finally {
        setIsSaving(false);
      }
    },
    [course_id, public_profile_id, router]
  );

  const saveDraft = useCallback(
    async (values: PollFormValues) => {
      await savePoll(values, false);
    },
    [savePoll]
  );

  const publishPoll = useCallback(
    async (values: PollFormValues) => {
      await savePoll(values, true);
    },
    [savePoll]
  );

  const onSubmit = handleSubmit(async (values) => {
    // Default to publishing when form is submitted
    await publishPoll(values);
  });

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <VStack align="center" gap={6} w="100%">
        <VStack align="stretch" gap={4} w="100%" maxW="800px">
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor={buttonBorderColor}
            color={buttonTextColor}
            _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
            onClick={() => router.push(`/course/${course_id}/manage/polls`)}
            alignSelf="flex-start"
          >
            ← Back to Polls
          </Button>

          <Heading size="xl" color={textColor} textAlign="left">
            Create Poll
          </Heading>
        </VStack>

        <Box
          w="100%"
          maxW="800px"
          bg={cardBgColor}
          border="1px solid"
          borderColor={borderColor}
          borderRadius="lg"
          p={8}
        >
          <form onSubmit={onSubmit}>
            <VStack align="stretch" gap={6}>
              <Box>
                <Field
                  label="Poll Question JSON"
                  errorText={errors.question?.message?.toString()}
                  invalid={!!errors.question}
                  required
                >
                  <Textarea
                    rows={12}
                    fontFamily="mono"
                    fontSize="sm"
                    bg={bgColor}
                    borderColor={borderColor}
                    color={textColor}
                    _placeholder={{ color: placeholderColor }}
                    _focus={{ borderColor: "blue.500" }}
                    {...register("question", {
                      required: "A JSON payload is required for the poll question"
                    })}
                  />

                  <HStack justify="space-between" mt={2} flexWrap="wrap" gap={2}>
                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor={buttonBorderColor}
                      color={buttonTextColor}
                      _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                      type="button"
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
                      type="button"
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
                      type="button"
                      onClick={validateJson}
                    >
                      Validate JSON
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor={buttonBorderColor}
                      color={buttonTextColor}
                      _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                      type="button"
                      onClick={showPreview}
                    >
                      Preview Poll
                    </Button>
                  </HStack>
                </Field>
              </Box>

              {/* Allow Multiple Responses */}
              <Box>
                <Controller
                  name="allowMultipleResponses"
                  control={control}
                  render={({ field }) => (
                    <Checkbox.Root
                      checked={field.value}
                      onCheckedChange={(details) => field.onChange(details.checked === true)}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label>
                        <Text fontSize="sm" color={textColor}>
                          Allow students to answer multiple times
                        </Text>
                      </Checkbox.Label>
                    </Checkbox.Root>
                  )}
                />
                <Text fontSize="xs" color={buttonTextColor} mt={1} ml={6}>
                  If unchecked, students can only submit one response. After submitting, they will be redirected.
                </Text>
              </Box>

              <HStack gap={4} justify="flex-start" pt={4}>
                <UIButton
                  type="submit"
                  loading={isSaving}
                  size="md"
                  bg="#22C55E"
                  color="white"
                  _hover={{ bg: "#16A34A" }}
                >
                  Publish Poll
                </UIButton>
                <Button
                  variant="outline"
                  bg="transparent"
                  borderColor={buttonBorderColor}
                  color={buttonTextColor}
                  _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                  onClick={handleSubmit(saveDraft)}
                  size="md"
                  type="button"
                  disabled={isSaving}
                >
                  Save as Draft
                </Button>
                <Button
                  variant="outline"
                  bg="transparent"
                  borderColor={buttonBorderColor}
                  color={buttonTextColor}
                  _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                  onClick={() => router.push(`/course/${course_id}/manage/polls`)}
                  size="md"
                  type="button"
                >
                  Cancel
                </Button>
              </HStack>
            </VStack>
          </form>
        </Box>
      </VStack>

      {/* Visual Builder Modal */}
      <PollBuilderModal
        isOpen={isBuilderOpen}
        onClose={() => setIsBuilderOpen(false)}
        onSave={handleBuilderSave}
        initialJson={questionValue}
      />

      {/* Preview Modal */}
      <PollPreviewModal
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        pollJson={questionValue}
      />
    </Box>
  );
}

