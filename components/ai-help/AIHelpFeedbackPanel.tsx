"use client";

import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { aiHelpFeedbackSubmit } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Box, HStack, Icon, IconButton, Text, Textarea, VStack } from "@chakra-ui/react";
import { useState } from "react";
import { BsX } from "react-icons/bs";
import { LuThumbsUp, LuThumbsDown } from "react-icons/lu";

export type AIHelpContextType = "help_request" | "discussion_thread" | "test_failure" | "build_error" | "test_insights";

interface AIHelpFeedbackPanelProps {
  /** Class ID for authorization */
  classId: number;
  /** Type of context being analyzed */
  contextType: AIHelpContextType;
  /** Resource ID (submission ID for test_failure/build_error, thread/request ID for others) */
  resourceId: number;
  /** Callback when panel is closed */
  onClose: () => void;
}

/**
 * Submit feedback via RPC
 */
async function submitFeedback(
  classId: number,
  contextType: AIHelpContextType,
  resourceId: number,
  rating: "thumbs_up" | "thumbs_down",
  comment?: string
): Promise<boolean> {
  try {
    const supabase = createClient();
    await aiHelpFeedbackSubmit(
      {
        class_id: classId,
        context_type: contextType,
        resource_id: resourceId,
        rating,
        comment: comment || undefined
      },
      supabase
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared feedback panel shown after copying AI context.
 * Used by all AI help buttons to collect user feedback.
 */
export function AIHelpFeedbackPanel({ classId, contextType, resourceId, onClose }: AIHelpFeedbackPanelProps) {
  const [rating, setRating] = useState<"thumbs_up" | "thumbs_down" | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!rating) return;

    setSubmitting(true);
    const success = await submitFeedback(classId, contextType, resourceId, rating, comment);
    setSubmitting(false);

    if (success) {
      setSubmitted(true);
      toaster.success({
        title: "Thanks for your feedback!",
        description: "Your feedback helps us improve the AI assistance feature."
      });
    } else {
      toaster.error({
        title: "Failed to submit feedback",
        description: "Please try again later."
      });
    }
  };

  if (submitted) {
    return (
      <Box p={3} borderWidth="1px" borderRadius="md" bg="green.subtle" maxW="400px">
        <HStack justify="space-between">
          <Text fontSize="sm" fontWeight="medium" color="green.fg">
            Thank you for your feedback!
          </Text>
          <IconButton aria-label="Close" size="xs" variant="ghost" onClick={onClose}>
            <Icon as={BsX} />
          </IconButton>
        </HStack>
      </Box>
    );
  }

  return (
    <Box p={3} borderWidth="1px" borderRadius="md" bg="bg.subtle" maxW="400px">
      <HStack justify="space-between" mb={2}>
        <Text fontSize="sm" fontWeight="medium">
          How was the AI assistance?
        </Text>
        <IconButton aria-label="Close" size="xs" variant="ghost" onClick={onClose}>
          <Icon as={BsX} />
        </IconButton>
      </HStack>

      <VStack gap={3} align="stretch">
        <HStack gap={2} justify="center">
          <IconButton
            aria-label="Thumbs up"
            size="lg"
            variant={rating === "thumbs_up" ? "solid" : "outline"}
            colorPalette={rating === "thumbs_up" ? "green" : "gray"}
            onClick={() => setRating("thumbs_up")}
          >
            <Icon as={LuThumbsUp} boxSize={5} />
          </IconButton>
          <IconButton
            aria-label="Thumbs down"
            size="lg"
            variant={rating === "thumbs_down" ? "solid" : "outline"}
            colorPalette={rating === "thumbs_down" ? "red" : "gray"}
            onClick={() => setRating("thumbs_down")}
          >
            <Icon as={LuThumbsDown} boxSize={5} />
          </IconButton>
        </HStack>

        <Textarea
          placeholder="Any additional feedback? (optional)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          fontSize="sm"
          rows={2}
          maxLength={2000}
        />

        <HStack gap={2}>
          <Button size="sm" variant="ghost" onClick={onClose} flex={1}>
            Skip
          </Button>
          <Button
            size="sm"
            colorPalette="purple"
            onClick={handleSubmit}
            disabled={!rating || submitting}
            loading={submitting}
            flex={1}
          >
            Submit
          </Button>
        </HStack>
      </VStack>
    </Box>
  );
}

export default AIHelpFeedbackPanel;
