import { HStack, Button } from "@chakra-ui/react";
import { useForm } from "@refinedev/react-hook-form";
import { createClient } from "@/utils/supabase/client";
import { useCreate, useInvalidate } from "@refinedev/core";
import { useState, useCallback } from "react";
import { SubmissionWithFilesAndComments, SubmissionFileWithComments, SubmissionFileComment } from "@/utils/supabase/DatabaseTypes";
import MessageInput from "./message-input";

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

    const postComment = useCallback(async (message: string) => {
        await createComment({
            values: {
                submissions_id: submission.id,
                submission_files_id: file.id,
                class_id: file.class_id,
                author: (await supabase.auth.getUser()).data.user!.id,
                line: lineNumber,
                comment: message
            }
        });
        invalidateQuery({ resource: "submission_files", id: file.id,
            invalidates: ['all'] });

    }, [submission, file, lineNumber, supabase, createComment]);


    return (
        <MessageInput
            className="w-full p-2 border rounded"
            defaultSingleLine={true}
            sendMessage={postComment}
        />
    );

}
export default LineCommentForm;