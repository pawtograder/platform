'use client';

import CodeFile from "@/components/ui/code-file";
import { Skeleton } from "@/components/ui/skeleton";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { Rubric, SubmissionWithFilesAndComments } from "@/utils/supabase/DatabaseTypes";
import { Box, Container, Editable, Flex, Heading, IconButton, Table } from "@chakra-ui/react";
import { useCreate, useInvalidate, useList, useShow } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { Controller } from "react-hook-form";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { LuCheck, LuPencilLine, LuX } from "react-icons/lu";
import { Button, Field, NumberInput } from "@chakra-ui/react"
import { useSubmission, useSubmissionFileComments, useSubmissionController } from "@/hooks/useSubmission";
import Link from "@/components/ui/link";

function FilePicker({ curFile, setCurFile }: { curFile: number, setCurFile: (file: number) => void }) {
    const submission = useSubmission();
    const isGraderOrInstructor = useIsGraderOrInstructor();
    const comments = useSubmissionFileComments({
    });
    const showCommentsFeature = submission.released !== null || isGraderOrInstructor;
    return (<Box maxH="250px" overflowY="auto" css={{
        '&::-webkit-scrollbar': {
            width: '8px',
            display: 'block'
        },
        '&::-webkit-scrollbar-track': {
            background: '#f1f1f1',
            borderRadius: '4px'
        },
        '&::-webkit-scrollbar-thumb': {
            background: '#888',
            borderRadius: '4px'
        },
        '&::-webkit-scrollbar-thumb:hover': {
            background: '#555'
        }
    }}>
        <Table.Root borderWidth="1px" borderColor="border.emphasized"
            w="4xl"
            m={2}
            borderRadius="md">
            <Table.Header>
                <Table.Row bg="bg.subtle">
                    <Table.ColumnHeader>File</Table.ColumnHeader>
                    {showCommentsFeature && <Table.ColumnHeader>Comments</Table.ColumnHeader>}
                </Table.Row>
            </Table.Header>
            <Table.Body>
                {submission.submission_files.map((file, idx) => (
                    <Table.Row key={file.id}>
                        <Table.Cell><Link
                            variant={curFile === idx ? "underline" : undefined} href={`/course/${submission.assignments.class_id}/assignments/${submission.assignments.id}/submissions/${submission.id}/files/?file_id=${file.id}`}>{file.name}</Link></Table.Cell>
                        {showCommentsFeature && <Table.Cell>{comments.filter((comment) => comment.submission_file_id === file.id).length}</Table.Cell>}
                    </Table.Row>
                ))}
            </Table.Body>
        </Table.Root>
    </Box>
    )
}
function RubricItem({ rubric }: { rubric: Rubric }) {
    const invalidateQuery = useInvalidate();
    const { register, control, getValues, handleSubmit, refineCore, formState: { errors, isSubmitting, isLoading } } = useForm<Rubric>({
        refineCoreProps: {
            action: "edit",
            resource: "rubrics",
            id: rubric.id,
        }
    });

    if (refineCore.query?.isLoading || refineCore.query?.isFetching) {
        return <Skeleton height="48px" width="full" />
    }
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
            <Field.Root invalid={!!errors.deduction} orientation="horizontal">
                <Field.Label>Deduction</Field.Label>
                <Controller
                    name="deduction"
                    control={control}
                    render={({ field }) => (
                        <NumberInput.Root
                            name={field.name}
                            value={field.value}
                            onValueChange={({ value }) => {
                                field.onChange(value)
                                handleSubmit(refineCore.onFinish)()
                            }}
                        >
                            <NumberInput.Control />
                            <NumberInput.Input onBlur={field.onBlur} />
                        </NumberInput.Root>
                    )}
                />
            </Field.Root>
        </form>
    </Box>
}
function RubricView() {
    const invalidateQuery = useInvalidate();
    const submission = useSubmission();
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
    return <Box
        position="sticky"
        top="0"
        borderLeftWidth="1px"
        borderColor="border.emphasized"
        p={4}
        ml={7}
        w="md"
        height="100vh"
        overflowY="auto"
    >
        <Heading size="xl">Rubric</Heading>
        <Box>
            <Heading size="lg">Criteria</Heading>
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
    const { role } = useClassProfiles();
    const isInstructor = role?.role === "instructor";
    const [curFile, setCurFile] = useState<number>(0);
    const searchParams = useSearchParams();
    const file_id = searchParams.get("file_id");
    const line = searchParams.get("line");
    const submission = useSubmission();
    const submissionController = useSubmissionController();
    useEffect(() => {
        if (file_id) {
            setCurFile(submission.submission_files.findIndex((file) => file.id === Number.parseInt(file_id)));
        }
    }, [file_id]);
    useEffect(() => {
        submissionController.file = submission.submission_files[curFile];
    }, [curFile]);
    return <Box pt={4} w="100%">
        <Flex w="100%">
            <Box w="100%">
                <FilePicker curFile={curFile} setCurFile={setCurFile} />
                <CodeFile file={submission.submission_files[curFile]} />
            </Box>
        </Flex>
    </Box>
}
