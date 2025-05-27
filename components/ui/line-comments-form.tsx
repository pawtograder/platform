import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useSubmissionReview } from "@/hooks/useSubmission";
import type {
  SubmissionFile,
  SubmissionFileComment,
  SubmissionWithFilesGraderResultsOutputTestsAndRubric
} from "@/utils/supabase/DatabaseTypes";
import { Box, Text } from "@chakra-ui/react";
import { useCreate, useInvalidate } from "@refinedev/core";
import { useCallback, useState } from "react";
import { Checkbox } from "./checkbox";
import MessageInput from "./message-input";
import { toaster } from "./toaster";

export default function LineCommentForm({
  lineNumber,
  submission,
  file,
  submissionReviewId,
  rubricCheckId,
  defaultText,
  defaultEventuallyVisible,
  defaultPoints,
  onCancel,
  onSubmitted
}: {
  lineNumber: number;
  submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric;
  file: SubmissionFile;
  submissionReviewId?: number;
  rubricCheckId?: number;
  defaultText?: string;
  defaultEventuallyVisible?: boolean;
  defaultPoints?: number;
  onCancel?: () => void;
  onSubmitted?: (comment: SubmissionFileComment) => void;
}) {
  const { mutateAsync: createComment, isLoading: isCreatingComment } = useCreate<SubmissionFileComment>({
    resource: "submission_file_comments"
  });
  const { private_profile_id } = useClassProfiles();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const invalidateQuery = useInvalidate();
  const [eventuallyVisible, setEventuallyVisible] = useState(defaultEventuallyVisible ?? true);

  const fetchedSubmissionReview = useSubmissionReview(submissionReviewId);
  const isLoadingReviewDetails = submissionReviewId !== undefined && fetchedSubmissionReview === undefined;

  const postComment = useCallback(
    async (message: string) => {
      if (!message && !rubricCheckId) {
        toaster.error({
          title: "Error posting comment",
          description: "Comment cannot be empty."
        });
        return;
      }
      if (submissionReviewId && !fetchedSubmissionReview && isLoadingReviewDetails) {
        toaster.error({ title: "Error posting comment", description: "Review context not fully loaded." });
        return;
      }

      const values: Partial<SubmissionFileComment> = {
        submission_id: submission.id,
        submission_file_id: file.id,
        class_id: file.class_id,
        author: private_profile_id!,
        line: lineNumber,
        comment: message,
        submission_review_id: submissionReviewId,
        rubric_check_id: rubricCheckId ?? null,
        points: defaultPoints ?? null,
        eventually_visible: isGraderOrInstructor ? eventuallyVisible : true
      };
      try {
        const created = await createComment({ values: values as SubmissionFileComment });
        invalidateQuery({ resource: "submission_files", id: file.id, invalidates: ["all"] });
        if (onSubmitted) onSubmitted(created.data as SubmissionFileComment);
        if (onCancel) onCancel();
        toaster.success({ title: "Comment posted" });
      } catch (err) {
        toaster.error({ title: "Error posting comment", description: (err as Error).message });
      }
    },
    [
      submission,
      file,
      lineNumber,
      createComment,
      private_profile_id,
      invalidateQuery,
      submissionReviewId,
      fetchedSubmissionReview,
      isLoadingReviewDetails,
      eventuallyVisible,
      rubricCheckId,
      defaultPoints,
      isGraderOrInstructor,
      onSubmitted,
      onCancel
    ]
  );

  if (isLoadingReviewDetails && submissionReviewId) {
    return <Text fontSize="sm">Loading review context...</Text>;
  }

  return (
    <Box>
      <MessageInput
        defaultValue={defaultText ?? ""}
        placeholder={rubricCheckId ? "Add an optional comment for this check..." : "Add a comment..."}
        className="w-full p-2 border rounded"
        defaultSingleLine={true}
        sendMessage={postComment}
        sendButtonText="Save"
        enableAnonymousModeToggle={false}
        enableFilePicker={false}
        enableGiphyPicker={false}
        enableEmojiPicker={true}
        allowEmptyMessage={!!rubricCheckId}
        onClose={onCancel}
      />
      {isGraderOrInstructor && (
        <Box mt={2} onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={eventuallyVisible}
            onCheckedChange={(details) => setEventuallyVisible(details.checked === true)}
            size="sm"
            disabled={isCreatingComment || (!!submissionReviewId && isLoadingReviewDetails)}
          >
            Visible to student when submission is released
          </Checkbox>
        </Box>
      )}
    </Box>
  );
}
