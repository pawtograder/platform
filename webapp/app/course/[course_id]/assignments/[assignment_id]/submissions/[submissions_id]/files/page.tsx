'use client';

import { Button } from "@/components/ui/button";
import CodeFile from "@/components/ui/code-file";
import { Skeleton } from "@/components/ui/skeleton";
import useAuthState from "@/hooks/useAuthState";
import { Rubric, SubmissionWithFilesAndComments } from "@/utils/supabase/DatabaseTypes";
import { Box, Container, Editable, Flex, IconButton, Link, Table } from "@chakra-ui/react";
import { useCreate, useInvalidate, useList, useShow } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { useParams, usePathname } from "next/navigation";
import { useState } from "react";
import { LuCheck, LuPencilLine, LuX } from "react-icons/lu";

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

    if (query.isLoading || !query.data) {
        return <Skeleton height="100%" width="100%" />
    }

    return <Container pt={4}>
        <Flex>
            <Box>
                <FilePicker submission={query.data.data} curFile={curFile} setCurFile={setCurFile} />
                <Box>
                    <CodeFile file={query.data.data.submission_files[curFile]} submission={query.data.data} />
                </Box>
            </Box>
            {isInstructor && <RubricView submission={query.data.data} />}
        </Flex>
    </Container>
}
