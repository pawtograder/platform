"use client";

import { Box, Dialog, Field, HStack, Icon, Stack, Text, Textarea } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useCreate } from "@refinedev/core";
import { useForm } from "react-hook-form";
import { BsX } from "react-icons/bs";
import { IoIosThumbsUp, IoIosThumbsDown } from "react-icons/io";
import { useState } from "react";
import { toaster } from "@/components/ui/toaster";
import type { HelpRequestFeedback } from "@/utils/supabase/DatabaseTypes";

type HelpRequestFeedbackModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (feedback?: HelpRequestFeedback) => void;
  helpRequestId: number;
  classId: number;
  studentProfileId: string;
};

/**
 * Modal component for collecting student feedback on help requests.
 * Allows students to provide thumbs up/down feedback and optional comments
 * when resolving or closing their help requests, or skip feedback entirely
 * while still resolving/closing the request.
 */
export default function HelpRequestFeedbackModal({
  isOpen,
  onClose,
  onSuccess,
  helpRequestId,
  classId,
  studentProfileId
}: HelpRequestFeedbackModalProps) {
  const [selectedRating, setSelectedRating] = useState<boolean | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting }
  } = useForm<HelpRequestFeedback>({
    defaultValues: {
      thumbs_up: true,
      comment: ""
    }
  });

  const { mutateAsync: createFeedback } = useCreate<HelpRequestFeedback>();

  const handleClose = () => {
    reset();
    setSelectedRating(null);
    onClose();
  };

  const onSubmit = async (data: HelpRequestFeedback) => {
    if (selectedRating === null) {
      toaster.error({
        title: "Rating Required",
        description: "Please select either thumbs up or thumbs down to rate your experience."
      });
      return;
    }

    try {
      const feedbackData = await createFeedback({
        resource: "help_request_feedback",
        values: {
          help_request_id: helpRequestId,
          class_id: classId,
          student_profile_id: studentProfileId,
          thumbs_up: selectedRating,
          comment: data.comment?.trim() || null
        }
      });

      toaster.success({
        title: "Feedback Submitted",
        description: "Thank you for your feedback! It helps us improve the help experience."
      });

      handleClose();
      onSuccess(feedbackData.data);
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to submit feedback: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  const handleSkipFeedback = () => {
    handleClose();
    // Call onSuccess without feedback data to resolve/close the request without recording feedback
    onSuccess();
  };

  const handleRatingSelect = (rating: boolean) => {
    setSelectedRating(rating);
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && handleClose()} size="md">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Rate Your Help Experience</Dialog.Title>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" size="sm">
                <Icon as={BsX} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Header>

          <Dialog.Body>
            <form onSubmit={handleSubmit(onSubmit)}>
              <Stack spaceY={6}>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={4}>
                    How was your help experience?
                  </Text>

                  <HStack justify="center" gap={8}>
                    {/* Thumbs Up Button */}
                    <Button
                      size="lg"
                      variant={selectedRating === true ? "solid" : "outline"}
                      colorPalette={selectedRating === true ? "green" : "gray"}
                      onClick={() => handleRatingSelect(true)}
                      type="button"
                      p={8}
                      flexDirection="column"
                      height="auto"
                      minHeight="100px"
                      width="120px"
                    >
                      <Icon as={IoIosThumbsUp} fontSize="2xl" mb={2} />
                      <Text fontSize="sm" fontWeight="medium">
                        Helpful
                      </Text>
                    </Button>

                    {/* Thumbs Down Button */}
                    <Button
                      size="lg"
                      variant={selectedRating === false ? "solid" : "outline"}
                      colorPalette={selectedRating === false ? "red" : "gray"}
                      onClick={() => handleRatingSelect(false)}
                      type="button"
                      p={8}
                      flexDirection="column"
                      height="auto"
                      minHeight="100px"
                      width="120px"
                    >
                      <Icon as={IoIosThumbsDown} fontSize="2xl" mb={2} />
                      <Text fontSize="sm" fontWeight="medium">
                        Not Helpful
                      </Text>
                    </Button>
                  </HStack>

                  {selectedRating === null && (
                    <Text colorPalette="orange" fontSize="sm" textAlign="center" mt={2}>
                      Please select a rating above
                    </Text>
                  )}
                </Box>

                <Field.Root>
                  <Field.Label>Additional Comments (Optional)</Field.Label>
                  <Textarea
                    {...register("comment")}
                    placeholder="Share any additional thoughts about your help experience..."
                    rows={4}
                    resize="vertical"
                  />
                  <Field.HelperText>
                    Help us improve by sharing what worked well or what could be better
                  </Field.HelperText>
                </Field.Root>

                <Box p={4} borderRadius="md" borderWidth="1px">
                  <Text fontSize="sm" lineHeight="1.5">
                    <strong>Your feedback is important!</strong> It helps instructors and TAs understand how to improve
                    the help experience and ensures quality assistance for all students.
                  </Text>
                </Box>
              </Stack>
            </form>
          </Dialog.Body>

          <Dialog.Footer>
            <HStack justify="end" gap={3}>
              <Button variant="outline" onClick={handleSkipFeedback}>
                Skip Feedback
              </Button>
              <Button
                colorPalette="green"
                onClick={handleSubmit(onSubmit)}
                loading={isSubmitting}
                disabled={selectedRating === null}
              >
                Submit Feedback
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
