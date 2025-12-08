"use client";

import { Box, Textarea, HStack, VStack, Button, Heading, Checkbox } from "@chakra-ui/react";
import { useForm, Controller } from "react-hook-form";
import { useParams, useRouter } from "next/navigation";
import { Field } from "@/components/ui/field";
import { Button as UIButton } from "@/components/ui/button";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/client";
import { Json } from "@/utils/supabase/SupabaseTypes";
import { toaster } from "@/components/ui/toaster";
import { useState } from "react";
import PollBuilderModal from "@/components/PollBuilderModal";
import { PollPreviewModal } from "@/components/PollPreviewModal";

type PollFormValues = {
  question: string;
  require_login: boolean;
};

const samplePollTemplate = `{
  "elements": [{
    "type": "checkbox",
    "title": "Which topic should we review next?",
    "choices": ["Recursion", "Dynamic Programming", "Graphs"]
  }]
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
    formState: { errors },
    getValues,
    setValue,
    watch,
    control
  } = useForm<PollFormValues>({
    defaultValues: {
      question: samplePollTemplate,
      require_login: false
    }
  });

  const questionValue = watch("question");

  const validateJson = (): boolean => {
    const jsonValue = getValues("question");
    if (!jsonValue.trim()) {
      toaster.create({
        title: "Missing question",
        description: "Please enter a JSON payload for your poll question.",
        type: "error"
      });
      return false;
    }
    try {
      const parsed = JSON.parse(jsonValue);

      // Ensure it has the elements array structure
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray(parsed.elements) ||
        parsed.elements.length === 0
      ) {
        toaster.create({
          title: "Invalid Question Format",
          description: "Question must be an object with an 'elements' array containing at least one element.",
          type: "error"
        });
        return false;
      }

      // Ensure the first element has required fields
      const firstElement = parsed.elements[0];
      if (!firstElement.type || !firstElement.title) {
        toaster.create({
          title: "Invalid Question Format",
          description: "The first element in 'elements' must have 'type' and 'title' fields.",
          type: "error"
        });
        return false;
      }

      toaster.create({
        title: "JSON valid",
        description: "Your poll question JSON looks good.",
        type: "success"
      });
      return true;
    } catch (error) {
      toaster.create({
        title: "Invalid JSON",
        description: error instanceof Error ? error.message : "Unable to parse the JSON payload.",
        type: "error"
      });
      return false;
    }
  };

  const loadSampleTemplate = () => {
    setValue("question", samplePollTemplate, { shouldDirty: true });
    toaster.create({
      title: "Sample loaded",
      description: "You can customize the template to match your poll.",
      type: "info"
    });
  };

  const handleBuilderSave = (json: string) => {
    setValue("question", json, { shouldDirty: true });
    toaster.create({
      title: "Poll question updated",
      description: "Your poll question has been updated from the visual builder.",
      type: "success"
    });
  };

  const showPreview = () => {
    // Validate JSON first before showing preview
    if (!validateJson()) {
      return;
    }
    setIsPreviewOpen(true);
  };

  const savePoll = async (values: PollFormValues, publish: boolean = false) => {
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

      // Ensure it has the elements array structure
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray(parsed.elements) ||
        parsed.elements.length === 0
      ) {
        toaster.create({
          title: "Invalid Question Format",
          description: "Question must be an object with an 'elements' array containing at least one element.",
          type: "error"
        });
        return;
      }

      // Ensure the first element has required fields
      const firstElement = parsed.elements[0];
      if (!firstElement.type || !firstElement.title) {
        toaster.create({
          title: "Invalid Question Format",
          description: "The first element in 'elements' must have 'type' and 'title' fields.",
          type: "error"
        });
        return;
      }

      parsedQuestion = parsed as Record<string, unknown>;
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
        .from("live_polls")
        .insert({
          class_id: Number(course_id),
          created_by: public_profile_id,
          question: parsedQuestion as Json,
          is_live: isLive,
          deactivates_at: deactivatesAt,
          require_login: values.require_login
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
        // Navigate back to polls page after publishing
        router.push(`/course/${course_id}/manage/polls`);
      } else {
        toaster.create({
          title: "Draft saved",
          description: "Your poll has been saved as a draft.",
          type: "success"
        });
        // Stay on the page when saving as draft so user can continue editing
      }
    } catch (error) {
      toaster.create({
        title: "Unable to save poll",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
        type: "error"
      });
    } finally {
      setIsSaving(false);
    }
  };

  const saveDraft = async (values: PollFormValues) => {
    await savePoll(values, false);
  };

  const onSubmit = handleSubmit(async (values) => {
    if (!validateJson()) {
      toaster.create({
        title: "Invalid poll JSON",
        description: "Please check your poll question format before submitting.",
        type: "error"
      });
      return;
    }

    // Default to saving when form is submitted
    await savePoll(values, true);
  });

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <VStack align="center" gap={6} w="100%">
        <VStack align="stretch" gap={4} w="100%" maxW="800px">
          <Button
            variant="outline"
            size="sm"
            bg="transparent"
            borderColor="border.emphasized"
            color="fg.muted"
            _hover={{ bg: "bg.muted" }}
            onClick={() => router.push(`/course/${course_id}/manage/polls`)}
            alignSelf="flex-start"
          >
            ← Back to Polls
          </Button>

          <Heading size="xl" color="fg" textAlign="left">
            Create Poll
          </Heading>
        </VStack>

        <Box
          w="100%"
          maxW="800px"
          bg="bg.subtle"
          border="1px solid"
          borderColor="border"
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
                    bg="bg.subtle"
                    borderColor="border"
                    color="fg.default"
                    _placeholder={{ color: "fg.muted" }}
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
                      borderColor="border.default"
                      color="fg.muted"
                      _hover={{ bg: "bg.muted" }}
                      type="button"
                      onClick={() => setIsBuilderOpen(true)}
                    >
                      Open Visual Builder
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor="border.default"
                      color="fg.muted"
                      _hover={{ bg: "bg.muted" }}
                      type="button"
                      onClick={loadSampleTemplate}
                    >
                      Load Sample Template
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor="border.default"
                      color="fg.muted"
                      _hover={{ bg: "bg.muted" }}
                      type="button"
                      onClick={validateJson}
                    >
                      Validate JSON
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      bg="transparent"
                      borderColor="border.default"
                      color="fg.muted"
                      _hover={{ bg: "bg.muted" }}
                      type="button"
                      onClick={showPreview}
                    >
                      Preview Poll
                    </Button>
                  </HStack>
                </Field>
              </Box>

              {/* Require Login */}
              <Box>
                <Controller
                  name="require_login"
                  control={control}
                  render={({ field }) => (
                    <Checkbox.Root
                      checked={field.value}
                      onCheckedChange={(details) => field.onChange(details.checked === true)}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label>
                        <Box fontSize="sm" color="fg.default">
                          Require login to respond
                        </Box>
                      </Checkbox.Label>
                    </Checkbox.Root>
                  )}
                />
                <Box fontSize="xs" color="fg.muted" mt={1} ml={6}>
                  If checked, only logged-in students can respond to this poll.
                </Box>
              </Box>

              <HStack gap={4} justify="flex-start" pt={4}>
                <UIButton
                  type="submit"
                  loading={isSaving}
                  size="md"
                  bg="green.500"
                  color="white"
                  _hover={{ bg: "green.600" }}
                >
                  Publish Poll
                </UIButton>
                <Button
                  variant="outline"
                  bg="transparent"
                  borderColor="border.default"
                  color="fg.muted"
                  _hover={{ bg: "bg.muted" }}
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
                  borderColor="border.default"
                  color="fg.muted"
                  _hover={{ bg: "bg.muted" }}
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
      <PollPreviewModal isOpen={isPreviewOpen} onClose={() => setIsPreviewOpen(false)} pollJson={questionValue} />
    </Box>
  );
}
