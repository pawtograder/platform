import { createClient } from "@/utils/supabase/client";
import { Rubric, SubmissionFile, SubmissionFileComment, SubmissionWithFilesGraderResultsOutputTestsAndRubric } from "@/utils/supabase/DatabaseTypes";
import { useCreate, useInvalidate, useList } from "@refinedev/core";
import { useCallback, useMemo, useRef, useState } from "react";
import MessageInput from "./message-input";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { Select, SelectInstance, ChakraStylesConfig } from "chakra-react-select"
import { Box, Field, Heading, HStack, NumberInput, Text, VStack } from "@chakra-ui/react";
import { LineActionPopupProps } from "./code-file";
import { useSubmissionReview } from "@/hooks/useSubmission";

type GroupedRubricOptions = {
    readonly label: string;
    readonly options: readonly RubricOption[];
}
type RubricOption = {
    readonly label: string;
    readonly value: string;
    readonly points: number;
    readonly description?: string;
    readonly isOther?: boolean;
    readonly rubric_id: number;
}

function LineCommentForm({
    lineNumber,
    submission,
    file
}: {
    lineNumber: number,
    submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric,
    file: SubmissionFile
}) {

    // const rubrics = submission.assignments.rubrics.filter((rubric) => rubric.is_annotation);
    // rubrics.sort((a, b) => a.ordinal - b.ordinal);

    const { mutateAsync: createComment } = useCreate<SubmissionFileComment>(
        {
            resource: "submission_file_comments",
        }
    );
    const supabase = createClient();
    const review = useSubmissionReview();
    const invalidateQuery = useInvalidate();
    const { private_profile_id } = useClassProfiles();
    const selectRef = useRef<SelectInstance<RubricOption, false, GroupedRubricOptions>>(null);
    const pointsRef = useRef<HTMLInputElement>(null);

    const postComment = useCallback(async (message: string) => {
        const values = {
            submission_id: submission.id,
            submission_file_id: file.id,
            class_id: file.class_id,
            author: private_profile_id!,
            line: lineNumber,
            comment: message,
            submission_review_id: review?.id,
            released: review ? false : true,
        }
        await createComment({
            values: values
        });
        invalidateQuery({
            resource: "submission_files", id: file.id,
            invalidates: ['all']
        });

    }, [submission, file, lineNumber, supabase, createComment, private_profile_id, selectRef]);

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