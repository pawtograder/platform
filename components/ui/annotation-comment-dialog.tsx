"use client";
import { useGraderPseudonymousMode } from "@/hooks/useAssignment";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useSubmissionController } from "@/hooks/useSubmission";
import {
  RubricCheck,
  RubricCriteria,
  SubmissionFile,
  SubmissionFileComment,
  SubmissionWithGraderResultsAndFiles
} from "@/utils/supabase/DatabaseTypes";
import { Box, Button, VStack, HStack, Text } from "@chakra-ui/react";
import { useState, useRef, useEffect } from "react";
import { Checkbox } from "./checkbox";
import MessageInput from "./message-input";
import { toaster } from "./toaster";
import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogCloseTrigger
} from "./dialog";
import { StudentVisibilityIndicator } from "./rubric-sidebar";
import { formatPoints } from "./code-file";

export type AnnotationCommentDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onSubmitted?: (comment: SubmissionFileComment) => void;
  onImmediateApply?: () => void;
  submission: SubmissionWithGraderResultsAndFiles;
  file: SubmissionFile;
  startLine: number;
  endLine: number;
  rubricCheck?: RubricCheck;
  criteria?: RubricCriteria;
  subOptionComment?: string;
  subOptionPoints?: number;
  submissionReviewId?: number;
  released?: boolean;
};

export function AnnotationCommentDialog({
  isOpen,
  onClose,
  onSubmitted,
  onImmediateApply,
  submission,
  file,
  startLine,
  endLine,
  rubricCheck,
  criteria,
  subOptionComment,
  subOptionPoints,
  submissionReviewId,
  released = true
}: AnnotationCommentDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const submissionController = useSubmissionController();
  const { private_profile_id, public_profile_id } = useClassProfiles();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const graderPseudonymousMode = useGraderPseudonymousMode();
  const authorProfileId = isGraderOrInstructor && graderPseudonymousMode ? public_profile_id : private_profile_id;
  const [eventuallyVisible, setEventuallyVisible] = useState(true);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      setEventuallyVisible(rubricCheck ? rubricCheck.student_visibility !== "never" : true);
      // Focus message input after dialog is fully rendered
      // Use multiple attempts to ensure focus works
      const focusInput = () => {
        if (messageInputRef.current) {
          // For single-line mode (textarea), focus directly
          messageInputRef.current.focus();
        } else {
          // Fallback: try to find textarea in the dialog
          const textarea = document.querySelector('[role="dialog"] textarea') as HTMLTextAreaElement;
          if (textarea) {
            textarea.focus();
          }
        }
      };
      
      // Try focusing after a short delay to ensure DOM is ready
      requestAnimationFrame(() => {
        setTimeout(focusInput, 100);
        // Also try again after a longer delay as fallback
        setTimeout(focusInput, 300);
      });
    } else {
      setIsLoading(false);
    }
  }, [isOpen, rubricCheck]);

  const handleSubmit = async (message: string) => {
    if (!message && rubricCheck?.is_comment_required) {
      toaster.error({
        title: "Error posting comment",
        description: "Comment is required for this check."
      });
      return;
    }

    if (submissionReviewId === undefined && rubricCheck?.id) {
      toaster.error({
        title: "Error saving comment",
        description: "Submission review ID is missing, cannot save rubric annotation."
      });
      return;
    }

    const points = subOptionPoints ?? rubricCheck?.points ?? null;
    let comment = message || "";
    if (subOptionComment) {
      comment = subOptionComment + (comment ? "\n" + comment : "");
    }

    const values = {
      comment,
      line: startLine,
      rubric_check_id: rubricCheck?.id ?? null,
      class_id: file.class_id!,
      submission_file_id: file.id,
      submission_id: submission.id,
      author: authorProfileId!,
      released,
      points,
      submission_review_id: submissionReviewId ?? null,
      eventually_visible: rubricCheck
        ? rubricCheck.student_visibility !== "never"
        : eventuallyVisible,
      regrade_request_id: null
    };

    try {
      setIsLoading(true);
      const created = await submissionController.submission_file_comments.create(
        values as Omit<
          SubmissionFileComment,
          "id" | "created_at" | "updated_at" | "deleted_at" | "edited_at" | "edited_by"
        >
      );

      if (onSubmitted) {
        onSubmitted(created as SubmissionFileComment);
      }
      
      // Scroll restoration is handled by the parent component via context
      // No need to restore here - parent will handle it when view zones update
      
      onClose();
      toaster.success({ title: "Annotation added" });
    } catch (err) {
      toaster.error({
        title: "Error saving annotation",
        description: err instanceof Error ? err.message : "Unknown error"
      });
    } finally {
      setIsLoading(false);
    }
  };

  const lineText = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  const points = subOptionPoints ?? rubricCheck?.points ?? null;
  const showPoints = points !== null && rubricCheck && criteria;

  return (
    <DialogRoot open={isOpen} onOpenChange={(e) => !e.open && onClose()}>
      <DialogContent maxW="2xl">
        <DialogHeader>
          <DialogTitle>
            {rubricCheck ? `Add ${rubricCheck.name}` : "Add Comment"} on {lineText}
          </DialogTitle>
          <DialogCloseTrigger />
        </DialogHeader>
        <DialogBody>
          <VStack gap={4} align="stretch">
            {rubricCheck && criteria && showPoints && (
              <Box>
                <Text fontSize="sm" fontWeight="semibold" mb={1}>
                  {criteria.name}
                </Text>
                <HStack gap={2}>
                  <Text fontSize="sm" color="fg.muted">
                    {formatPoints({ check: rubricCheck, criteria, points })}
                  </Text>
                  <StudentVisibilityIndicator
                    check={rubricCheck}
                    isApplied={true}
                    isReleased={released}
                  />
                </HStack>
              </Box>
            )}

            {subOptionComment && (
              <Box p={2} bg="bg.subtle" borderRadius="md">
                <Text fontSize="sm" color="fg.muted">
                  {subOptionComment}
                </Text>
              </Box>
            )}

            <MessageInput
              textAreaRef={messageInputRef}
              enableGiphyPicker={false}
              enableFilePicker={false}
              enableEmojiPicker={true}
              enableAnonymousModeToggle={false}
              sendButtonText={rubricCheck ? "Add Check" : "Add Comment"}
              placeholder={
                !rubricCheck
                  ? `Add a comment about ${lineText}...`
                  : rubricCheck.is_comment_required
                    ? "Add a comment about this check (required)..."
                    : "Optionally add a comment, or just press enter to submit..."
              }
              allowEmptyMessage={rubricCheck ? !rubricCheck.is_comment_required : false}
              defaultSingleLine={true}
              sendMessage={handleSubmit}
              onClose={onClose}
              className="w-full p-2 border rounded"
            />

            {isGraderOrInstructor && !rubricCheck && (
              <Box>
                <Checkbox
                  checked={eventuallyVisible}
                  onCheckedChange={(details) => setEventuallyVisible(details.checked === true)}
                  size="sm"
                  disabled={isLoading}
                >
                  Visible to student when submission is released
                </Checkbox>
              </Box>
            )}
          </VStack>
        </DialogBody>
        <DialogFooter>
          <HStack gap={2}>
            {rubricCheck && !rubricCheck.is_comment_required && onImmediateApply && (
              <Button
                variant="solid"
                colorPalette="green"
                onClick={() => {
                  if (onImmediateApply) {
                    onImmediateApply();
                  }
                  onClose();
                }}
                disabled={isLoading}
              >
                Apply
              </Button>
            )}
            <Button variant="ghost" onClick={onClose} disabled={isLoading}>
              Cancel
            </Button>
          </HStack>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
