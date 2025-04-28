'use client';

import CodeFile from "@/components/ui/code-file";
import { Skeleton } from "@/components/ui/skeleton";
import useAuthState from "@/hooks/useAuthState";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { Rubric, SubmissionArtifact, SubmissionWithFilesAndComments } from "@/utils/supabase/DatabaseTypes";
import { Box, ClientOnly, Container, Editable, Flex, Heading, IconButton, Spinner, Table, Text } from "@chakra-ui/react";
import { useCreate, useInvalidate, useList, useShow } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { Controller } from "react-hook-form";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { LuCheck, LuPencilLine, LuX } from "react-icons/lu";
import { Button, Field, NumberInput } from "@chakra-ui/react"
import { useSubmission, useSubmissionFileComments, useSubmissionController, useSubmissionComments, useSubmissionArtifactComments } from "@/hooks/useSubmission";
import Link from "@/components/ui/link";
import { createClient } from "@/utils/supabase/client";
import JSZip from 'jszip';
import zipToHTMLBlobs from "./zipToHTMLBlobs";

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
function ArtifactPicker({ curArtifact }: { curArtifact: number }) {
    const submission = useSubmission();
    const isGraderOrInstructor = useIsGraderOrInstructor();
    const comments = useSubmissionArtifactComments({
    });
    const showCommentsFeature = submission.released !== null || isGraderOrInstructor;
    if (!submission.submission_artifacts || submission.submission_artifacts.length === 0) {
        return <></>
    }
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
                    <Table.ColumnHeader>Artifact</Table.ColumnHeader>
                    {showCommentsFeature && <Table.ColumnHeader>Comments</Table.ColumnHeader>}
                </Table.Row>
            </Table.Header>
            <Table.Body>
                {submission.submission_artifacts.map((artifact, idx) => (
                    <Table.Row key={artifact.id}>
                        <Table.Cell><Link
                            variant={curArtifact === idx ? "underline" : undefined} href={`/course/${submission.assignments.class_id}/assignments/${submission.assignments.id}/submissions/${submission.id}/files/?artifact_id=${artifact.id}`}>{artifact.name}</Link></Table.Cell>
                        {showCommentsFeature && <Table.Cell>{comments.filter((comment) => comment.submission_artifact_id === artifact.id).length}</Table.Cell>}
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

function ArtifactView({ artifact }: { artifact: SubmissionArtifact }) {
    //Load the artifact data from supabase
    const [artifactData, setArtifactData] = useState<Blob | null>(null);
    const [siteUrl, setSiteUrl] = useState<string | null>(null);
    const artifactKey = `classes/${artifact.class_id}/profiles/${artifact.profile_id ? artifact.profile_id : artifact.assignment_group_id}/submissions/${artifact.submission_id}/${artifact.id}`;
    useEffect(() => {
        let cleanup: (() => void) | undefined = undefined;
        async function loadArtifact() {
            const client = createClient();
            const data = await client.storage.from('submission-artifacts').download(artifactKey);
            if (data.data) {
                setArtifactData(data.data);
                if (artifact.data.format === 'zip' && artifact.data.display === 'html_site') {
                    try {
                        //TODO fix nested rewriting
                        // Use JSZip to unzip the file
                        const zip = await JSZip.loadAsync(data.data);
                        const { rewrittenHTMLFiles, topLevelDir } = await zipToHTMLBlobs(data.data);
                        const listener = async (event: MessageEvent) => {
                            if (event.data.type === 'REQUEST_FILE_CONTENTS') {
                                // Create a map of file contents
                                const fileContents: Record<string, string | Uint8Array> = {};
                                //Find the top level directory
                                // Process all files in parallel
                                await Promise.all(
                                    Object.entries(zip.files).map(async ([path, file]) => {
                                        const pathRelativeToTopLevelDir = path.replace(topLevelDir, '');
                                        if (!file.dir) {
                                            // Get the content based on file type
                                            if (pathRelativeToTopLevelDir.endsWith('.html')) {
                                                fileContents[pathRelativeToTopLevelDir] = rewrittenHTMLFiles.get(pathRelativeToTopLevelDir)!;
                                            } else if (pathRelativeToTopLevelDir.endsWith('.css') || pathRelativeToTopLevelDir.endsWith('.js') || pathRelativeToTopLevelDir.endsWith('.json')) {
                                                fileContents[pathRelativeToTopLevelDir] = await file.async('text');
                                            } else {
                                                fileContents[pathRelativeToTopLevelDir] = await file.async('uint8array');
                                            }
                                        }
                                    })
                                );
                                // Send all file contents to the iframe
                                event.source?.postMessage({ 
                                    type: 'FILE_CONTENTS_RESPONSE', 
                                    fileContents 
                                }, {targetOrigin: '*'});
                            }
                        };
                        window.addEventListener('message', listener);
                        cleanup = () => {
                            window.removeEventListener('message', listener);
                        }
                        if (rewrittenHTMLFiles.get('/index.html')) {
                            const url = URL.createObjectURL(new Blob([rewrittenHTMLFiles.get('/index.html')!], { type: 'text/html' }));
                            setSiteUrl(url);
                        }
                    } catch (error) {
                        console.error('Error processing ZIP file:', error);
                    }
                }
            }
            if (data.error) {
                console.error(data.error);
            }
        }
        loadArtifact();
        return () => {
            console.log('Outer cleanup')
            if (cleanup) {
                cleanup();
            }

        }
    }, [artifactKey]);
    if (artifact.data.format === 'png') {
        if (artifactData) {
            return <img src={URL.createObjectURL(artifactData)} alt={artifact.name} />
        }
        else {
            return <Spinner />
        }
    } else if (artifact.data.format === 'zip') {
        if (artifact.data.display === 'html_site') {
            if (siteUrl) {
                return (
                    <Box>
                        <ClientOnly>
                            <Button onClick={() => {
                                const client = createClient();
                                client.storage.from('submission-artifacts').createSignedUrl(artifactKey, 60 * 60 * 24 * 30).then((data) => {
                                    //Coerce download of the signed url
                                    const a = document.createElement('a');
                                    a.href = data?.data?.signedUrl || '';
                                    a.download = artifact.name;
                                    a.click();
                                });
                            }}>Download</Button>
                            <Box borderWidth="1px" borderColor="border.emphasized" borderRadius="md" overflow="hidden">
                                <iframe
                                    src={siteUrl}
                                    style={{ width: '100%', height: '100%', border: 'none' }}
                                    title={artifact.name}
                                    sandbox="allow-scripts"
                                />
                            </Box>
                        </ClientOnly>
                    </Box>
                );
            } else {
                return <Spinner />;
            }
        }
    }
    return <Box>
        <Text>{artifact.name}</Text>
    </Box>
}

export default function FilesView() {
    const { submissions_id } = useParams();
    const { role } = useClassProfiles();
    const isInstructor = role?.role === "instructor";
    const [curFile, setCurFile] = useState<number>(0);
    const [curArtifact, setCurArtifact] = useState<number>(0);
    const [currentView, setCurrentView] = useState<"file" | "artifact">("file");
    const searchParams = useSearchParams();
    const file_id = searchParams.get("file_id");
    const artifact_id = searchParams.get("artifact_id");
    const line = searchParams.get("line");
    const submission = useSubmission();
    const submissionController = useSubmissionController();
    useEffect(() => {
        if (file_id) {
            setCurrentView("file");
            setCurFile(submission.submission_files.findIndex((file) => file.id === Number.parseInt(file_id)));
        }
    }, [file_id]);
    useEffect(() => {
        if (artifact_id) {
            setCurrentView("artifact");
            setCurArtifact(submission.submission_artifacts.findIndex((artifact) => artifact.id === Number.parseInt(artifact_id)));
        }
    }, [artifact_id]);
    useEffect(() => {
        submissionController.file = submission.submission_files[curFile];
    }, [curFile]);
    useEffect(() => {
        submissionController.artifact = submission.submission_artifacts[curArtifact] as SubmissionArtifact;
    }, [curArtifact]);
    return <Box pt={4} w="100%">
        <Flex w="100%">
            <Box w="100%">
                <FilePicker curFile={curFile} setCurFile={setCurFile} />
                <ArtifactPicker curArtifact={curArtifact} />
                {currentView === "file" && <CodeFile file={submission.submission_files[curFile]} />}
                {currentView === "artifact" && <ArtifactView artifact={submission.submission_artifacts[curArtifact] as SubmissionArtifact} />}
            </Box>
        </Flex>
    </Box>
}
