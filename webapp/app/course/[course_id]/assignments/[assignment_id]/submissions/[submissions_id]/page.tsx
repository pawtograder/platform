'use client';

import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, chakra, HStack, Tabs, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import SyntaxHighlighter, { createElement } from 'react-syntax-highlighter';
import { docco, github } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { UnstableGetResult as GetResult } from '@supabase/postgrest-js';
import { useCreate, useInvalidate, useShow } from "@refinedev/core";
import { Button } from "@/components/ui/button";
import { SubmissionWithFilesAndComments } from "@/utils/supabase/DatabaseTypes";
import { SubmissionFileWithComments } from "@/utils/supabase/DatabaseTypes";
import FilesView from "./filesView";
import GraderResults from "./graderResults";



function LineCommentForm({
    line,
    submission,
    curFile
}: {
    line: number,
    submission: SubmissionWithFilesAndComments,
    curFile: SubmissionFileWithComments
}) {
    const form = useForm();
    const [isReplying, setIsReplying] = useState(false);
    const supabase = createClient();
    const invalidateQuery = useInvalidate();

    const onSubmit = useCallback(async (data: any) => {
        if (!submission || !data.comment) return;

        try {
            const { error } = await supabase
            .from('submission_file_comments')
            .insert({
                submissions_id: submission.id,
                submission_files_id: curFile.id,
                class_id: curFile.class_id,
                author: (await supabase.auth.getUser()).data.user!.id,
                line: line,
                comment: data.comment
            });

            // await createComment({
            //     values: {
            //         submissionsid: submission.id,
            //         submission_files_id: curFile.id,
            //         class_id: curFile.class_id,
            //         author: (await supabase.auth.getUser()).data.user!.id,
            //         line: line,
            //         comment: data.comment
            //     },
            // });

            form.reset();
            invalidateQuery({
                resource: "submissions",
                id: submission.id,
                invalidates: ['all']

            })
            setIsReplying(false);
        } catch (error) {
            console.error('Error posting comment:', error);
        }
    }, [submission, line, form, supabase]);

    if (!isReplying) {
        return (
            <Box>
                <Button
                    onClick={() => setIsReplying(true)}
                    fontSize="sm"
                    color="blue.500"
                    _hover={{ textDecoration: 'underline' }}
                >
                    Reply
                </Button>
            </Box>
        );
    }

    return (
        <Box as="form" onSubmit={form.handleSubmit(onSubmit)}>
            <textarea
                {...form.register('comment', { required: true })}
                rows={3}
                className="w-full p-2 border rounded"
                placeholder="Write a comment..."
            />
            <HStack spaceY={2} mt={2}>
                <Button
                    type="submit"
                    bg="blue.500"
                    color="white"
                    px={4}
                    py={2}
                    rounded="md"
                    _hover={{ bg: 'blue.600' }}
                >
                    Post
                </Button>
                <Button
                    onClick={() => setIsReplying(false)}
                    color="gray.500"
                    px={4}
                    py={2}
                >
                    Cancel
                </Button>
            </HStack>
        </Box>
    );

}
function LineComments({
    line,
    submission,
    curFile
}: {
    line: number,
    submission: SubmissionWithFilesAndComments,
    curFile: SubmissionFileWithComments
}) {
    if (!submission || !curFile) {
        return null;
    }
    return <Box>
        <Box
            position="relative"
            m={0}
            maxW="sm"
            borderWidth="1px"
            borderColor="gray.400"
            p={4}
            backgroundColor="gray.200"
            fontFamily={"sans-serif"}
            _before={{
                content: '""',
                position: "absolute",
                top: "-3px",
                left: "16px",
                width: "6px",
                height: "6px",
                borderWidth: "1px 0 0 1px",
                backgroundColor: "gray.200",
                borderColor: "gray.400",
                borderStyle: "solid",
                transform: "rotate(45deg)"

            }}
            boxShadow="sm"
        >
            Comment
            <LineCommentForm line={line} submission={submission} curFile={curFile} />
            {curFile.submission_file_comments?.filter((comment) => comment.line === line).map((comment) => (
                <Box key={comment.id} mt={2} borderWidth="1px" borderColor="gray.400" p={2} borderRadius="md">
                    <Text fontSize="sm" fontWeight="bold">{comment.author}</Text>
                    {comment.comment}
                </Box>
            ))}
        </Box>
        {/* ))} */}
    </Box>
}
export default function SubmissionsView() {
    const { submissions_id } = useParams();
    const [curFile, setCurFile] = useState<number>(0);
    const { query } = useShow<SubmissionWithFilesAndComments>({
        resource: "submissions",
        id: Number(submissions_id),
        meta: {
            select: "*, assignments(*), submission_files(*, submission_file_comments(*))"
        }
    });
    return <Box>
        <Tabs.Root lazyMount defaultValue="results">
            <Tabs.List>
                <Tabs.Trigger value="results">Grading Script Results</Tabs.Trigger>
                <Tabs.Trigger value="files">Files</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="files">
                <FilesView submission_id={Number(submissions_id)} />
            </Tabs.Content>
            <Tabs.Content value="results">
                <GraderResults submission_id={Number(submissions_id)} />
            </Tabs.Content>
        </Tabs.Root>
    </Box>
}
