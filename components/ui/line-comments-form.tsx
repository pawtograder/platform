import {
  SubmissionFile,
  SubmissionFileComment,
  SubmissionWithFilesGraderResultsOutputTestsAndRubric
} from "@/utils/supabase/DatabaseTypes";
import { useCreate, useInvalidate } from "@refinedev/core";
import { useCallback, useState } from "react";
import MessageInput from "./message-input";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useSubmissionReviewByAssignmentId } from "@/hooks/useSubmission";
import { Checkbox } from "./checkbox";
import { Box, Text } from "@chakra-ui/react";
import { toaster } from "./toaster";
export default function LineCommentForm({
  lineNumber,
  submission,
  file,
  reviewAssignmentId
}: {
  lineNumber: number;
  submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric;
  file: SubmissionFile;
  reviewAssignmentId?: number;
}) {
  const { mutateAsync: createComment, isLoading: isCreatingComment } = useCreate<SubmissionFileComment>({
    resource: "submission_file_comments"
  });
  const {
    submissionReview,
    isLoading: isLoadingReview,
    error: reviewError
  } = useSubmissionReviewByAssignmentId(reviewAssignmentId);

  const invalidateQuery = useInvalidate();
  const { private_profile_id } = useClassProfiles();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const [eventuallyVisible, setEventuallyVisible] = useState(true);

  const postComment = useCallback(
    async (message: string) => {
      if (reviewAssignmentId && !submissionReview?.id) {
        toaster.error({
          title: "Error posting comment",
          description: "Submission review context not loaded, cannot post comment for this review assignment."
        });
        return;
      }

      const values = {
        submission_id: submission.id,
        submission_file_id: file.id,
        class_id: file.class_id,
        author: private_profile_id!,
        line: lineNumber,
        comment: message,
        submission_review_id: submissionReview?.id,
        released: submissionReview ? submissionReview.released : !reviewAssignmentId,
        eventually_visible: eventuallyVisible
      };
      await createComment({ values: values });
      invalidateQuery({ resource: "submission_files", id: file.id, invalidates: ["all"] });
    },
    [
      submission,
      file,
      lineNumber,
      createComment,
      private_profile_id,
      invalidateQuery,
      submissionReview,
      eventuallyVisible,
      reviewAssignmentId
    ]
  );

  if (isLoadingReview && reviewAssignmentId) {
    return <Text fontSize="sm">Loading review context...</Text>;
  }

  if (reviewError && reviewAssignmentId) {
    return (
      <Text color="red.500" fontSize="sm">
        Error loading review context: {reviewError.message}
      </Text>
    );
  }

  return (
    <Box w="100%">
      <MessageInput
        className="w-full p-2 border rounded"
        defaultSingleLine={true}
        sendMessage={postComment}
        sendButtonText="Save"
      />
      {isGraderOrInstructor && (
        <Box mt={2} mb={1}>
          <Checkbox
            inputProps={{
              checked: eventuallyVisible,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setEventuallyVisible(e.target.checked),
              disabled: isCreatingComment || (!!reviewAssignmentId && !submissionReview?.id)
            }}
          >
            Visible to student upon release
          </Checkbox>
        </Box>
      )}
    </Box>
  );
}
