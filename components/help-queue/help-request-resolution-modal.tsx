"use client";

import { Box, Dialog, Field, HStack, Icon, Stack, Text, Textarea } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useCreate } from "@refinedev/core";
import { useForm } from "react-hook-form";
import { BsX, BsLightbulb, BsPeople, BsClock, BsQuestionCircle, BsPersonCheck } from "react-icons/bs";
import { IoIosThumbsUp, IoIosThumbsDown } from "react-icons/io";
import { useState } from "react";
import { toaster } from "@/components/ui/toaster";
import type { HelpRequestFeedback, HelpRequestResolutionStatus } from "@/utils/supabase/DatabaseTypes";

type ResolutionOption = {
  value: HelpRequestResolutionStatus;
  label: string;
  description: string;
  icon: typeof BsLightbulb;
  colorPalette: string;
};

const RESOLUTION_OPTIONS: ResolutionOption[] = [
  {
    value: "self_solved",
    label: "I solved it myself",
    description: "I figured out the solution on my own",
    icon: BsLightbulb,
    colorPalette: "green"
  },
  {
    value: "staff_helped",
    label: "Staff helped me",
    description: "A TA or instructor helped me",
    icon: BsPersonCheck,
    colorPalette: "blue"
  },
  {
    value: "peer_helped",
    label: "A peer helped me",
    description: "Another student helped me",
    icon: BsPeople,
    colorPalette: "purple"
  },
  {
    value: "no_time",
    label: "No time to wait",
    description: "I don't have time to wait for help",
    icon: BsClock,
    colorPalette: "orange"
  },
  {
    value: "other",
    label: "Other",
    description: "Another reason",
    icon: BsQuestionCircle,
    colorPalette: "gray"
  }
];

type HelpRequestResolutionModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (resolutionStatus: HelpRequestResolutionStatus, feedback?: HelpRequestFeedback, notes?: string) => void;
  helpRequestId: number;
  classId: number;
  studentProfileId: string;
  showFeedback?: boolean; // Whether to show the thumbs up/down feedback section
  title?: string;
};

type FormData = {
  comment: string;
  notes: string;
};

/**
 * Modal component for resolving help requests with status selection and optional feedback.
 * Students select how their issue was resolved and can optionally provide feedback.
 */
export default function HelpRequestResolutionModal({
  isOpen,
  onClose,
  onSuccess,
  helpRequestId,
  classId,
  studentProfileId,
  showFeedback = true,
  title = "Resolve Help Request"
}: HelpRequestResolutionModalProps) {
  const [selectedResolution, setSelectedResolution] = useState<HelpRequestResolutionStatus | null>(null);
  const [selectedRating, setSelectedRating] = useState<boolean | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting }
  } = useForm<FormData>({
    defaultValues: {
      comment: "",
      notes: ""
    }
  });

  const { mutateAsync: createFeedback } = useCreate<HelpRequestFeedback>();

  const handleClose = () => {
    reset();
    setSelectedResolution(null);
    setSelectedRating(null);
    onClose();
  };

  const onSubmit = async (data: FormData) => {
    if (!selectedResolution) {
      toaster.error({
        title: "Resolution Required",
        description: "Please select how your request was resolved."
      });
      return;
    }

    try {
      let feedbackData: HelpRequestFeedback | undefined;

      // If feedback is shown and a rating was provided, submit it
      if (showFeedback && selectedRating !== null) {
        const response = await createFeedback({
          resource: "help_request_feedback",
          values: {
            help_request_id: helpRequestId,
            class_id: classId,
            student_profile_id: studentProfileId,
            thumbs_up: selectedRating,
            comment: data.comment?.trim() || null
          }
        });
        feedbackData = response.data;
      }

      handleClose();
      onSuccess(selectedResolution, feedbackData, data.notes?.trim() || undefined);

      toaster.success({
        title: "Request Resolved",
        description: "Thank you for letting us know how your request was resolved."
      });
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to resolve request: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  const handleSkip = () => {
    if (!selectedResolution) {
      toaster.error({
        title: "Resolution Required",
        description: "Please select how your request was resolved before continuing."
      });
      return;
    }
    handleClose();
    onSuccess(selectedResolution, undefined, undefined);
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="lg">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" size="sm">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
            <form onSubmit={handleSubmit(onSubmit)}>
              <Stack spaceY={6}>
                {/* Resolution Status Selection */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={3}>
                    How was your issue resolved?
                  </Text>

                  <Stack spaceY={2} role="radiogroup" aria-label="How was your issue resolved?">
                    {RESOLUTION_OPTIONS.map((option) => {
                      const isSelected = selectedResolution === option.value;
                      return (
                        <Box
                          key={option.value}
                          role="radio"
                          tabIndex={0}
                          aria-checked={isSelected}
                          aria-label={`${option.label}${isSelected ? ", selected" : ""}`}
                          p={3}
                          borderWidth="2px"
                          borderColor={isSelected ? `${option.colorPalette}.500` : "border.emphasized"}
                          borderRadius="lg"
                          cursor="pointer"
                          onClick={() => setSelectedResolution(option.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelectedResolution(option.value);
                            }
                          }}
                          bg={isSelected ? `${option.colorPalette}.50` : "bg.surface"}
                          _hover={{
                            borderColor: isSelected ? `${option.colorPalette}.500` : `${option.colorPalette}.300`,
                            bg: isSelected ? `${option.colorPalette}.50` : "bg.subtle"
                          }}
                          _focus={{
                            outline: "2px solid",
                            outlineColor: `${option.colorPalette}.500`,
                            outlineOffset: "2px"
                          }}
                          _dark={{
                            bg: isSelected ? `${option.colorPalette}.900` : "bg.surface",
                            _hover: {
                              bg: isSelected ? `${option.colorPalette}.900` : "bg.subtle"
                            },
                            _focus: {
                              outline: "2px solid",
                              outlineColor: `${option.colorPalette}.400`,
                              outlineOffset: "2px"
                            }
                          }}
                          transition="all 0.2s"
                        >
                          <HStack gap={3}>
                            <Box
                              p={2}
                              borderRadius="md"
                              bg={isSelected ? `${option.colorPalette}.100` : "bg.muted"}
                              _dark={{
                                bg: isSelected ? `${option.colorPalette}.800` : "bg.muted"
                              }}
                            >
                              <Icon
                                as={option.icon}
                                boxSize={5}
                                color={isSelected ? `${option.colorPalette}.600` : "fg.muted"}
                                _dark={{
                                  color: isSelected ? `${option.colorPalette}.300` : "fg.muted"
                                }}
                              />
                            </Box>
                            <Box flex={1}>
                              <Text fontWeight="medium" fontSize="sm">
                                {option.label}
                              </Text>
                              <Text fontSize="xs" color="fg.muted">
                                {option.description}
                              </Text>
                            </Box>
                            {isSelected && (
                              <Box
                                w={4}
                                h={4}
                                borderRadius="full"
                                bg={`${option.colorPalette}.500`}
                                display="flex"
                                alignItems="center"
                                justifyContent="center"
                              >
                                <Box w={2} h={2} borderRadius="full" bg="white" />
                              </Box>
                            )}
                          </HStack>
                        </Box>
                      );
                    })}
                  </Stack>

                  {selectedResolution === null && (
                    <Text color="orange.500" fontSize="sm" mt={2}>
                      Please select an option above
                    </Text>
                  )}
                </Box>

                {/* Optional Notes for 'Other' */}
                {selectedResolution === "other" && (
                  <Field.Root>
                    <Field.Label>Please describe (optional)</Field.Label>
                    <Textarea
                      {...register("notes")}
                      placeholder="Let us know what happened..."
                      rows={2}
                      resize="vertical"
                    />
                  </Field.Root>
                )}

                {/* Feedback Section (Optional) */}
                {showFeedback && (
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={3}>
                      Did we help? (optional)
                    </Text>

                    <HStack justify="center" gap={6}>
                      {/* Thumbs Up Button */}
                      <Button
                        size="lg"
                        variant={selectedRating === true ? "solid" : "outline"}
                        colorPalette={selectedRating === true ? "green" : "gray"}
                        onClick={() => setSelectedRating(selectedRating === true ? null : true)}
                        type="button"
                        p={6}
                        flexDirection="column"
                        height="auto"
                        minHeight="80px"
                        width="100px"
                      >
                        <Icon as={IoIosThumbsUp} fontSize="xl" mb={1} />
                        <Text fontSize="xs" fontWeight="medium">
                          Helpful
                        </Text>
                      </Button>

                      {/* Thumbs Down Button */}
                      <Button
                        size="lg"
                        variant={selectedRating === false ? "solid" : "outline"}
                        colorPalette={selectedRating === false ? "red" : "gray"}
                        onClick={() => setSelectedRating(selectedRating === false ? null : false)}
                        type="button"
                        p={6}
                        flexDirection="column"
                        height="auto"
                        minHeight="80px"
                        width="100px"
                      >
                        <Icon as={IoIosThumbsDown} fontSize="xl" mb={1} />
                        <Text fontSize="xs" fontWeight="medium">
                          Not Helpful
                        </Text>
                      </Button>
                    </HStack>
                  </Box>
                )}

                {/* Additional Comments (only shown if feedback is provided) */}
                {showFeedback && selectedRating !== null && (
                  <Field.Root>
                    <Field.Label>Additional Comments (optional)</Field.Label>
                    <Textarea
                      {...register("comment")}
                      placeholder="Share any additional thoughts about your help experience..."
                      rows={3}
                      resize="vertical"
                    />
                    <Field.HelperText>Your feedback helps instructors improve the help experience</Field.HelperText>
                  </Field.Root>
                )}
              </Stack>
            </form>
          </Dialog.Body>

          <Dialog.Footer>
            <HStack justify="space-between" w="100%">
              <Button variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <HStack gap={2}>
                {showFeedback && (
                  <Button variant="outline" onClick={handleSkip} disabled={!selectedResolution}>
                    Skip Feedback
                  </Button>
                )}
                <Button
                  colorPalette="green"
                  onClick={handleSubmit(onSubmit)}
                  loading={isSubmitting}
                  disabled={!selectedResolution}
                >
                  {showFeedback && selectedRating !== null ? "Submit & Resolve" : "Resolve Request"}
                </Button>
              </HStack>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
