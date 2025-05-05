import {
  SubmissionFile,
  SubmissionFileComment,
  SubmissionWithFilesGraderResultsOutputTestsAndRubric
} from "@/utils/supabase/DatabaseTypes";
import { useCreate, useInvalidate } from "@refinedev/core";
import { useCallback } from "react";
import MessageInput from "./message-input";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useSubmissionReview } from "@/hooks/useSubmission";

// type GroupedRubricOptions = { readonly label: string; readonly options: readonly RubricOption[] };
// type RubricOption = {
//   readonly label: string;
//   readonly value: string;
//   readonly points: number;
//   readonly description?: string;
//   readonly isOther?: boolean;
//   readonly rubric_id: number;
// };

function LineCommentForm({
  lineNumber,
  submission,
  file
}: {
  lineNumber: number;
  submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric;
  file: SubmissionFile;
}) {
  // const rubrics = submission.assignments.rubrics.filter((rubric) => rubric.is_annotation);
  // rubrics.sort((a, b) => a.ordinal - b.ordinal);

  const { mutateAsync: createComment } = useCreate<SubmissionFileComment>({ resource: "submission_file_comments" });
  const review = useSubmissionReview();
  const invalidateQuery = useInvalidate();
  const { private_profile_id } = useClassProfiles();

  const postComment = useCallback(
    async (message: string) => {
      const values = {
        submission_id: submission.id,
        submission_file_id: file.id,
        class_id: file.class_id,
        author: private_profile_id!,
        line: lineNumber,
        comment: message,
        submission_review_id: review?.id,
        released: review ? false : true
      };
      await createComment({ values: values });
      invalidateQuery({ resource: "submission_files", id: file.id, invalidates: ["all"] });
    },
    [submission, file, lineNumber, createComment, private_profile_id, invalidateQuery, review]
  );

  return (
    <MessageInput
      className="w-full p-2 border rounded"
      defaultSingleLine={true}
      sendMessage={postComment}
      sendButtonText="Save"
    />
  );
}
export default LineCommentForm;
