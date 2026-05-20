"use client";
import { Button } from "@/components/ui/button";
import { Box, HStack, Text, Textarea } from "@chakra-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Sentry from "@sentry/nextjs";

import { GraderResultTestsHintFeedback } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { useClassProfiles } from "@/hooks/useClassProfiles";

export function HintFeedbackForm({
  testId,
  submissionId,
  classId,
  hintText,
  onFeedbackSubmitted
}: {
  testId: number;
  submissionId: number;
  classId: number;
  hintText: string;
  onFeedbackSubmitted?: () => void;
}) {
  const [useful, setUseful] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [existingFeedback, setExistingFeedback] = useState<GraderResultTestsHintFeedback | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { private_profile_id } = useClassProfiles();
  const debounceTimeoutRef = useRef<NodeJS.Timeout>();

  // Fetch existing feedback on mount
  useEffect(() => {
    const fetchExistingFeedback = async () => {
      try {
        const supabase = createClient();

        const { data: feedback, error: fetchError } = await supabase
          .from("grader_result_tests_hint_feedback")
          .select("*")
          .eq("grader_result_tests_id", testId)
          .eq("created_by", private_profile_id)
          .maybeSingle();

        if (feedback && !fetchError) {
          const typedFeedback = feedback;
          setExistingFeedback(typedFeedback);
          setUseful(typedFeedback.useful);
          setComment(typedFeedback.comment || "");
          setHasSubmitted(true); // Show as submitted if feedback exists
        }
      } finally {
        setIsLoading(false);
      }
    };

    fetchExistingFeedback();
  }, [testId, classId, private_profile_id]);

  // Auto-save function
  const saveFeedback = useCallback(
    async (newUseful?: boolean | null, newComment?: string) => {
      const usefulToSave = newUseful !== undefined ? newUseful : useful;
      const commentToSave = newComment !== undefined ? newComment : comment;

      if (usefulToSave === null) return; // Don't save if no useful rating

      setIsSaving(true);
      setError(null);

      try {
        const supabase = createClient();

        if (existingFeedback) {
          // Update existing feedback
          const { data: updatedFeedback, error: updateError } = await supabase
            .from("grader_result_tests_hint_feedback")
            .update({
              useful: usefulToSave,
              comment: commentToSave.trim() || null
            })
            .eq("id", existingFeedback.id)
            .select()
            .single();

          if (updateError) {
            setError("Failed to save feedback: " + updateError.message);
            return;
          }

          if (updatedFeedback) {
            setExistingFeedback(updatedFeedback as unknown as GraderResultTestsHintFeedback);
          }
        } else {
          // Insert new feedback
          const { data: newFeedback, error: insertError } = await supabase
            .from("grader_result_tests_hint_feedback")
            .insert({
              class_id: classId,
              grader_result_tests_id: testId,
              submission_id: submissionId,
              hint: hintText,
              useful: usefulToSave,
              comment: commentToSave.trim() || null,
              created_by: private_profile_id
            })
            .select()
            .single();

          if (insertError) {
            setError("Failed to save feedback: " + insertError.message);
            return;
          }

          if (newFeedback) {
            setExistingFeedback(newFeedback as unknown as GraderResultTestsHintFeedback);
          }
        }
      } catch (err) {
        Sentry.captureException(err);
        setError("An error occurred while saving feedback");
      } finally {
        setIsSaving(false);
      }
    },
    [useful, comment, existingFeedback, classId, testId, submissionId, hintText, private_profile_id]
  );

  // Handle thumbs up/down with immediate save
  const handleUsefulChange = useCallback(
    async (newUseful: boolean) => {
      setUseful(newUseful);
      await saveFeedback(newUseful, comment);
    },
    [saveFeedback, comment]
  );

  // Handle comment change with debounced save
  const handleCommentChange = useCallback(
    (newComment: string) => {
      setComment(newComment);

      // Clear existing timeout
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      // Set new timeout for 3 seconds
      debounceTimeoutRef.current = setTimeout(() => {
        if (useful !== null) {
          // Only save if useful rating exists
          saveFeedback(useful, newComment);
        }
      }, 3000);
    },
    [useful, saveFeedback]
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  const handleSubmit = async () => {
    if (useful === null) return;

    setIsSubmitting(true);

    // Clear any pending debounced save
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // Save immediately
    await saveFeedback();

    setHasSubmitted(true);
    setIsEditing(false);
    onFeedbackSubmitted?.();
    setIsSubmitting(false);
  };

  if (isLoading) {
    return (
      <Box mt={4} p={3} bg="bg.muted" borderRadius="md" border="1px solid" borderColor="border.emphasized">
        <Text fontSize="sm" color="fg.muted">
          Loading feedback...
        </Text>
      </Box>
    );
  }

  if (hasSubmitted && !isEditing) {
    return (
      <Box mt={4} p={3} bg="bg.subtle" borderRadius="md" borderLeft="4px solid" borderColor="green.500">
        <HStack justify="space-between" align="start">
          <Box>
            <Text fontSize="sm" color="fg.muted" fontWeight="medium">
              Your feedback: {useful ? "👍 Helpful" : "👎 Not helpful"}
            </Text>
            {comment && (
              <Text fontSize="sm" color="fg.muted" mt={1}>
                &quot;{comment}&quot;
              </Text>
            )}
            <Text fontSize="xs" color="fg.muted" mt={1}>
              Thank you for helping us improve Feedbot!
            </Text>
          </Box>
          <Button size="xs" variant="ghost" onClick={() => setIsEditing(true)}>
            Edit
          </Button>
        </HStack>
      </Box>
    );
  }

  return (
    <Box mt={4} p={3} bg="bg.muted" borderRadius="md" border="1px solid" borderColor="border.emphasized">
      <Text fontSize="sm" fontWeight="medium" mb={3}>
        {existingFeedback ? "Update your feedback:" : "Was this Feedbot response helpful?"}
      </Text>

      <HStack justify="space-between" align="center" mb={3}>
        <HStack>
          <Button
            size="sm"
            variant={useful === true ? "surface" : "outline"}
            colorPalette={useful === true ? "green" : "gray"}
            onClick={() => handleUsefulChange(true)}
          >
            👍 Yes
          </Button>
          <Button
            size="sm"
            variant={useful === false ? "surface" : "outline"}
            colorPalette={useful === false ? "red" : "gray"}
            onClick={() => handleUsefulChange(false)}
          >
            👎 No
          </Button>
        </HStack>
        {isSaving && (
          <Text fontSize="xs" color="fg.muted">
            Saving...
          </Text>
        )}
      </HStack>

      <Textarea
        placeholder="Optional: Tell us more about your experience with this hint to help us improve..."
        value={comment}
        onChange={(e) => handleCommentChange(e.target.value)}
        size="sm"
        mb={3}
        maxLength={500}
        aria-label="Additional feedback about this Feedbot response (optional)"
      />

      <HStack>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={useful === null || isSubmitting}
          loading={isSubmitting}
          colorPalette="green"
          variant="solid"
        >
          {existingFeedback ? "Update Feedback" : "Submit Feedback"}
        </Button>
        {isEditing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setIsEditing(false);
              setUseful(existingFeedback?.useful ?? null);
              setComment(existingFeedback?.comment || "");
            }}
          >
            Cancel
          </Button>
        )}
        {error && (
          <Text fontSize="xs" color="red.500">
            {error}
          </Text>
        )}
      </HStack>
    </Box>
  );
}
