'use client';

import { Button } from "@/components/ui/button";
import PersonName from "@/components/ui/person-name";
import { Skeleton } from "@/components/ui/skeleton";
import useAuthState from "@/hooks/useAuthState";
import { createClient } from "@/utils/supabase/client";
import { Rubric, SubmissionFileWithComments, SubmissionWithFilesAndComments } from "@/utils/supabase/DatabaseTypes";
import { Box, chakra, Container, Editable, Flex, HStack, IconButton, Link, Table, Text } from "@chakra-ui/react";
import { useCreate, useInvalidate, useList, useShow } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useParams, usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { FaPlus } from "react-icons/fa";
import { LuCheck, LuPencilLine, LuX } from "react-icons/lu";
import SyntaxHighlighter, { createElement } from 'react-syntax-highlighter';
import { github } from 'react-syntax-highlighter/dist/esm/styles/hljs';


function LineCommentForm({
    line,
    submission,
    curFile
}: {
    line: number,
    submission: SubmissionWithFilesAndComments,
    curFile: SubmissionFileWithComments
}) {
    const { setValue, handleSubmit,
        register,
        refineCore
    } = useForm({
        refineCoreProps: {
            action: "create",
            resource: "submission_file_comments",
            onMutationSuccess: () => {
                invalidateQuery({
                    resource: "submissions",
                    id: submission.id,
                    invalidates: ['all']
                });
                setIsReplying(false);
            }
        }
    });
    const [isReplying, setIsReplying] = useState(false);
    const supabase = createClient();
    const invalidateQuery = useInvalidate();

    const onSubmit = useCallback((e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        async function populate() {
            setValue('submissions_id', submission.id);
            setValue('submission_files_id', curFile.id);
            setValue('class_id', curFile.class_id);
            setValue('author', (await supabase.auth.getUser()).data.user!.id);
            setValue('line', line);
            handleSubmit(refineCore.onFinish)();
            setValue('comment', '');
        }
        populate();
    }, [submission, line, supabase]);


    // if (!isReplying) {
    //     return (
    //         <Box>
    //             <Button
    //                 onClick={() => setIsReplying(true)}
    //                 fontSize="sm"
    //                 _hover={{ textDecoration: 'underline' }}
    //             >
    //                 Reply
    //             </Button>
    //         </Box>
    //     );
    // }

    return (
        <form onSubmit={onSubmit}>
            <textarea
                {...register('comment', { required: true })}
                rows={3}
                className="w-full p-2 border rounded"
                placeholder="Write a comment..."
                onKeyDown={(e) => {
                    if (e.metaKey && e.key === 'Enter') {
                        e.preventDefault();
                        onSubmit(e as unknown as React.FormEvent<HTMLFormElement>);
                    }
                }}
            />
            <HStack spaceY={2} mt={2}>
                <Button
                    type="submit"
                    px={4}
                    py={2}
                    rounded="md"
                    _hover={{ bg: 'blue.600' }}
                >
                    Post
                </Button>
                {/* <Button
                    onClick={() => setIsReplying(false)}
                    color="gray.500"
                    px={4}
                    py={2}
                >
                    Cancel
                </Button> */}
            </HStack>
        </form>
    );

}
function LineComments({
    line,
    expanded,
    setExpanded,
    submission,
    curFile
}: {
    line: number,
    submission: SubmissionWithFilesAndComments,
    curFile: SubmissionFileWithComments,
    expanded: boolean,
    setExpanded: (expanded: boolean) => void
}) {

    if (!submission || !curFile) {
        return null;
    }
    const comments = curFile.submission_file_comments?.filter((comment) => comment.line === line);
    const hasComments = comments && comments.length > 0;
    if (!expanded && !hasComments) {
        return <></>;
    }
    return <Box position="relative" m={0}>
        <Box position="absolute" left={0}
            w="40px" h="100%"
            borderLeft="1px solid #ccc" borderRight="1px solid #ccc"></Box>
        <Box
            position="relative"
            maxW="sm"
            ml={2}
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
            {curFile.submission_file_comments?.filter((comment) => comment.line === line).map((comment) => (
                <Box key={comment.id} mt={2} borderWidth="1px" borderColor="gray.400" p={2} borderRadius="md">
                    <PersonName uid={comment.author} />
                    <Text>{comment.comment}</Text>
                </Box>
            ))}
            <LineCommentForm line={line} submission={submission} curFile={curFile} />
        </Box>
        {/* ))} */}
    </Box>
}
const LineNumber = chakra("div", {
    base: {
        width: "40px",
        textAlign: "right",
        borderRight: "1px solid #ccc",
        borderLeft: "1px solid #ccc",
        padding: "0 4px",
    }
});

function CodeLine({ line, row, stylesheet, useInlineStyles, data, curFile }: { line: number, row: any, stylesheet: any, useInlineStyles: any, data: SubmissionWithFilesAndComments, curFile: number }) {
    const [isExpanded, setIsExpanded] = useState(false);

    return (<div>
        <Box
            display="flex"
            alignItems="center"
            position="relative"
            _hover={{
                bg: "yellow.100",
                cursor: "pointer",
                "& > .plus-icon": {
                    opacity: 1
                }
            }}
            onClick={() => setIsExpanded(!isExpanded)}
        >
            <Box
                className="plus-icon"
                position="absolute"
                left="4px"
                opacity={0}
                transition="opacity 0.2s"
            >
                <FaPlus />
            </Box>
            <LineNumber>{line + 1}</LineNumber>
            <Box>{createElement({ node: row, stylesheet, useInlineStyles, key: line })}
            </Box>
        </Box>
        <LineComments line={line + 1} expanded={isExpanded} setExpanded={setIsExpanded} submission={data} curFile={data.submission_files[curFile]} />
    </div>)
}
function FilePicker({ submission, curFile, setCurFile }: { submission: SubmissionWithFilesAndComments, curFile: number, setCurFile: (file: number) => void }) {
    return (
        <Table.Root borderWidth="1px" borderColor="border.emphasized"
            w="2xl"
            m={2}
            borderRadius="md">
            <Table.Header>
                <Table.Row bg="bg.subtle">
                    <Table.ColumnHeader>File</Table.ColumnHeader>
                    <Table.ColumnHeader>Comments</Table.ColumnHeader>
                </Table.Row>
            </Table.Header>
            <Table.Body>
                {submission.submission_files.map((file, idx) => (
                    <Table.Row key={file.id}>
                        <Table.Cell><Link variant={curFile === idx ? "underline" : undefined} onClick={() => setCurFile(idx)}>{file.name}</Link></Table.Cell>
                        <Table.Cell>{file.submission_file_comments?.length || 0}</Table.Cell>
                    </Table.Row>
                ))}
            </Table.Body>
        </Table.Root>
    )
}
function RubricItem({ rubric }: { rubric: Rubric }) {
    const invalidateQuery = useInvalidate();
    const { register, control, getValues, handleSubmit, refineCore, formState: { errors, isSubmitting } } = useForm<Rubric>({
        refineCoreProps: {
            action: "edit",
            resource: "rubrics",
            id: rubric.id,
        }
    });
    console.log(getValues("name"));
    return <Box>
        <form onSubmit={handleSubmit(refineCore.onFinish)}>
            <Editable.Root {...register("name")} placeholder="Click to enter a comment"
                submitMode="both"
                onValueCommit={(details) => {
                    handleSubmit(refineCore.onFinish)()
                }}
            >
                <Editable.Preview minH="48px" alignItems="flex-start" width="full">{getValues("name")}</Editable.Preview>
                <Editable.Input />
                <Editable.Control>
                    <Editable.EditTrigger asChild>
                        <IconButton variant="ghost" size="xs">
                            <LuPencilLine />
                        </IconButton>
                    </Editable.EditTrigger>
                    <Editable.CancelTrigger asChild>
                        <IconButton variant="outline" size="xs">
                            <LuX />
                        </IconButton>
                    </Editable.CancelTrigger>
                    <Editable.SubmitTrigger asChild>
                        <IconButton variant="outline" size="xs">
                            <LuCheck />
                        </IconButton>
                    </Editable.SubmitTrigger>
                </Editable.Control>

            </Editable.Root>
        </form>
    </Box>
}
function RubricView({ submission }: { submission: SubmissionWithFilesAndComments }) {
    const invalidateQuery = useInvalidate();
    const { data: rubrics } = useList<Rubric>({
        resource: "rubrics",
        filters: [
            {
                field: "class_id",
                operator: "eq",
                value: submission.assignments.class_id
            }
        ],
        sorters: [
            {
                field: "ordinal",
                order: "asc"
            }
        ],
        meta: {
            select: "*"
        },
    });
    const { mutate: addRubric } = useCreate<Rubric>({
        resource: "rubrics",
        mutationOptions: {
            onSuccess: () => {
                invalidateQuery({ resource: "rubrics", invalidates: ['all'] });
            }
        }
    });
    return <Box borderLeftWidth="1px" borderColor="border.emphasized" p={4} ml={7} w="md">
        <h2>Rubric</h2>
        <Box>
            <h3>Criteria</h3>
            {rubrics?.data.map((rubric) => (
                <Box key={rubric.id}>
                    <RubricItem rubric={rubric} />
                </Box>
            ))}
            <Button onClick={() => {
                addRubric({
                    values: {
                        class_id: submission.assignments.class_id,
                        name: "New Rubric Item",
                        deduction: 0,
                        ordinal: rubrics?.data.length || 0
                    }
                })
            }}>Add Rubric Item</Button>
        </Box>
    </Box>
}
export default function FilesView() {
    const { submissions_id } = useParams();
    const { isInstructor } = useAuthState();
    const [curFile, setCurFile] = useState<number>(0);
    const pathname = usePathname();
    const { query } = useShow<SubmissionWithFilesAndComments>({
        resource: "submissions",
        id: Number.parseInt(submissions_id as string),
        meta: {
            select: "*, assignments(*), submission_files(*, submission_file_comments(*, public_profiles(*)))"
        }
    });

    const renderer = useCallback(
        ({ rows, stylesheet, useInlineStyles }: rendererProps) => {

            if (!query.data) return <></>;
            return (
                <div style={{ height: '100%' }}>
                    {rows.map((row, i) => <CodeLine data={query.data.data} curFile={curFile} line={i} row={row} stylesheet={stylesheet} useInlineStyles={useInlineStyles} key={i} />)}
                </div>)
        }, [query.data, curFile]);

    if (query.isLoading || !query.data) {
        return <Skeleton height="100%" width="100%" />
    }

    return <Container pt={4}>
        <Flex>
            <Box>
                <FilePicker submission={query.data.data} curFile={curFile} setCurFile={setCurFile} />
                <Box>
                    <SyntaxHighlighter showLineNumbers={false}
                        wrapLines={true}
                        renderer={renderer}
                        language='java' style={github}>
                        {query.data.data.submission_files[curFile]?.contents || ''}
                    </SyntaxHighlighter>
                </Box>
            </Box>
            {isInstructor && <RubricView submission={query.data.data} />}
        </Flex>
    </Container>
}
