import { createClient } from "@/utils/supabase/client";
import { SubmissionFileComment, SubmissionFileWithComments, SubmissionWithFilesAndComments } from "@/utils/supabase/DatabaseTypes";
import { useCreate, useInvalidate } from "@refinedev/core";
import { useCallback, useState } from "react";
import MessageInput from "./message-input";
import useAuthState from "@/hooks/useAuthState";

function LineCommentForm({
    lineNumber,
    submission,
    file
}: {
    lineNumber: number,
    submission: SubmissionWithFilesAndComments,
    file: SubmissionFileWithComments
}) {

    const { mutateAsync: createComment } = useCreate<SubmissionFileComment>(
        {
            resource: "submission_file_comments",
        }
    );
    const [isReplying, setIsReplying] = useState(false);
    const supabase = createClient();
    const invalidateQuery = useInvalidate();
    const { private_profile_id } = useAuthState();

    const postComment = useCallback(async (message: string) => {
        console.log(JSON.stringify({
            submissions_id: submission.id,
            submission_files_id: file.id,
            class_id: file.class_id,
            author: private_profile_id!,
            line: lineNumber,
            comment: message
                }))
        await createComment({
            values: {
                submissions_id: submission.id,
                submission_files_id: file.id,
                class_id: file.class_id,
                author: private_profile_id!,
                line: lineNumber,
                comment: message
            }
        });
        invalidateQuery({ resource: "submission_files", id: file.id,
            invalidates: ['all'] });

    }, [submission, file, lineNumber, supabase, createComment, private_profile_id]);


    return (
        <MessageInput
            className="w-full p-2 border rounded"
            defaultSingleLine={true}
            sendMessage={postComment}
        />
    );

}
export default LineCommentForm;