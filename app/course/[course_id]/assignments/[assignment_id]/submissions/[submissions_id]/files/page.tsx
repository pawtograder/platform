'use client';

import CodeFile from "@/components/ui/code-file";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import PersonAvatar from "@/components/ui/person-avatar";
import { CommentActions } from "@/components/ui/rubric-sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from '@/components/ui/tooltip';
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useRubricCheck, useSubmission, useSubmissionArtifactComments, useSubmissionController, useSubmissionFileComments, useSubmissionReview } from "@/hooks/useSubmission";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { createClient } from "@/utils/supabase/client";
import { Rubric, SubmissionArtifact, SubmissionArtifactComment, SubmissionFileComment, SubmissionWithFilesGraderResultsOutputTestsAndRubric } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, ClientOnly, Editable, Field, Flex, Heading, HStack, Icon, IconButton, NumberInput, Spinner, Table, Tag, Text, VStack } from "@chakra-ui/react";
import { useCreate, useInvalidate, useList, useUpdate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { SelectInstance } from "chakra-react-select";
import { format } from "date-fns";
import JSZip, { file } from 'jszip';
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Controller } from "react-hook-form";
import { FaCheckCircle, FaEyeSlash, FaFile, FaTimesCircle } from "react-icons/fa";
import { LuCheck, LuPencilLine, LuX } from "react-icons/lu";
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

function ArtifactAnnotation({ comment }: { comment: SubmissionArtifactComment }) {
    const { rubricCheck, rubricCriteria } = useRubricCheck(comment.rubric_check_id);
    if (!rubricCheck || !rubricCriteria) {
        return <Skeleton height="100px" width="100%" />;
    }
    const gradingReview = useSubmissionReview(comment.submission_review_id);
    const reviewName = comment.submission_review_id ? gradingReview?.name : "Self-Review";

    const pointsText = rubricCriteria.is_additive ? `+${comment.points}` : `-${comment.points}`;
    const commentAuthor = useUserProfile(comment.author);
    const [isEditing, setIsEditing] = useState(false);
    const messageInputRef = useRef<HTMLTextAreaElement>(null);
    const { mutateAsync: updateComment } = useUpdate({
        resource: "submission_artifact_comments",
    });
    return <Box m={0} p={0} w="100%" pb={1}>
        <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
            <PersonAvatar size="2xs" uid={comment.author} />
            <VStack alignItems="flex-start" spaceY={0} gap={0} w="100%" border="1px solid" borderColor="border.info" borderRadius="md" >
                <Box bg="bg.info" pl={1} pr={1} borderRadius="md">
                    <Flex w="100%" justifyContent="space-between">
                        <HStack>
                            {!comment.released && <Tooltip content="This comment is not released to the student yet"><Icon as={FaEyeSlash} /></Tooltip>}
                            <Icon as={
                                rubricCriteria.is_additive ? FaCheckCircle : FaTimesCircle} color={rubricCriteria.is_additive ? "green.500" : "red.500"} />{pointsText}
                            <Text fontSize="sm" color="fg.muted">{rubricCriteria?.name} &gt; {rubricCheck?.name}</Text>
                        </HStack>
                        <HStack gap={0}>
                            <Text fontSize="sm" fontStyle="italic" color="fg.muted">{commentAuthor?.name} ({reviewName})</Text>
                            <CommentActions comment={comment} setIsEditing={setIsEditing} />
                        </HStack>
                    </Flex>
                </Box>
                <Box pl={2}>
                    <Markdown style={{ fontSize: '0.8rem' }}>{rubricCheck.description}</Markdown>
                </Box>
                <Box pl={2}>
                    {isEditing ? <MessageInput
                        textAreaRef={messageInputRef}
                        defaultSingleLine={true}
                        value={comment.comment}
                        closeButtonText="Cancel"
                        onClose={() => {
                            setIsEditing(false);
                        }}
                        sendMessage={async (message, profile_id) => {
                            await updateComment({ id: comment.id, values: { comment: message } });
                            setIsEditing(false);
                        }} /> : <Markdown>{comment.comment}</Markdown>}
                </Box>
            </VStack>
        </HStack>
    </Box >
}
function ArtifactComment({ comment, submission }: { comment: SubmissionArtifactComment, submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric }) {
    const authorProfile = useUserProfile(comment.author);
    const isAuthor = submission.profile_id === comment.author || submission?.assignment_groups?.assignment_groups_members?.some((member) => member.profile_id === comment.author);
    const [isEditing, setIsEditing] = useState(false);
    const messageInputRef = useRef<HTMLTextAreaElement>(null);
    const { mutateAsync: updateComment } = useUpdate({
        resource: "submission_artifact_comments",
    });
    return <Box key={comment.id} m={0} pb={1} w="100%">
        <HStack spaceX={0} mb={0} alignItems="flex-start" w="100%">
            <PersonAvatar size="2xs" uid={comment.author} />
            <VStack alignItems="flex-start" spaceY={0} gap={1} w="100%" border="1px solid" borderColor="border.emphasized" borderRadius="md" >
                <HStack w="100%" justifyContent="space-between" bg="bg.muted" p={0} borderTopRadius="md" borderBottom="1px solid" borderColor="border.emphasized">
                    <HStack gap={1} fontSize="sm" color="fg.muted" ml={1}>
                        <Text fontWeight="bold">{authorProfile?.name}</Text>
                        <Text>commented on {format(comment.created_at, 'MMM d, yyyy')}</Text>
                    </HStack>
                    <HStack>{isAuthor || authorProfile?.flair ? <Tag.Root size="md" colorScheme={isAuthor ? "green" : "gray"} variant="surface">
                        <Tag.Label>{isAuthor ? "Author" : authorProfile?.flair}</Tag.Label>
                    </Tag.Root> : <></>}
                        <CommentActions comment={comment} setIsEditing={setIsEditing} />
                    </HStack>
                </HStack>
                <Box pl={2}>
                    {isEditing ? <MessageInput
                        textAreaRef={messageInputRef}
                        defaultSingleLine={true}
                        value={comment.comment}
                        closeButtonText="Cancel"
                        onClose={() => {
                            setIsEditing(false);
                        }}
                        sendMessage={async (message, profile_id) => {
                            await updateComment({ id: comment.id, values: { comment: message } });
                            setIsEditing(false);
                        }} /> : <Markdown>{comment.comment}</Markdown>}
                </Box>
            </VStack>
        </HStack>
    </Box>
}


function AritfactComments({ artifact }: { artifact: SubmissionArtifact }) {
    const comments = useSubmissionArtifactComments({}).filter((comment) => comment.deleted_at === null && comment.submission_artifact_id === artifact.id);
    const submission = useSubmission();

    const isGraderOrInstructor = useIsGraderOrInstructor();
    const isReplyEnabled = isGraderOrInstructor || submission.released !== null;
    const [showReply, setShowReply] = useState(isReplyEnabled);
    const showCommentsFeature = submission.released !== null || isGraderOrInstructor;

    if (!submission || !artifact || !showCommentsFeature) {
        return null;
    }
    return <Box
        width="100%"
        p={4}
        whiteSpace="normal"
        position="relative" m={0} borderTop="1px solid"
        borderBottom="1px solid"
        borderColor="border.emphasized">
        <Box position="absolute" left={0}
            w="40px" h="100%"
            borderRight="1px solid #ccc"></Box>
        <Box
            position="relative"
            w="100%"
            fontFamily={"sans-serif"}

            m={0}
            borderWidth="1px"
            borderColor="border.emphasized"
            borderRadius="md"
            p={0}
            backgroundColor="bg"
            boxShadow="sm"
        >
            {comments.map((comment) => (
                comment.rubric_check_id ? <ArtifactAnnotation key={comment.id} comment={comment} /> :
                    <ArtifactComment key={comment.id} comment={comment} submission={submission} />
            ))}
            {showReply ? <ArtifactCommentsForm submission={submission} artifact={artifact} defaultValue={comments.length > 0 ? "Reply" : "Add Comment"} /> : <Box display="flex" justifyContent="flex-end"><Button colorPalette="green" onClick={() => setShowReply(true)}>Add Comment</Button></Box>}
        </Box>
    </Box>
}
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

function ArtifactCommentsForm({
    submission,
    artifact,
    defaultValue
}: {
    submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric,
    artifact: SubmissionArtifact,
    defaultValue: string
}) {

    // const rubrics = submission.assignments.rubrics.filter((rubric) => rubric.is_annotation);
    // rubrics.sort((a, b) => a.ordinal - b.ordinal);

    const { mutateAsync: createComment } = useCreate<SubmissionArtifactComment>(
        {
            resource: "submission_artifact_comments",
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
            submission_artifact_id: artifact.id,
            class_id: artifact.class_id,
            author: private_profile_id!,
            comment: message,
            submission_review_id: review?.id,
            released: review ? false : true,
        }
        await createComment({
            values: values
        });
        invalidateQuery({
            resource: "submission_artifacts", id: artifact.id,
            invalidates: ['all']
        });

    }, [submission, artifact, supabase, createComment, private_profile_id, selectRef]);

    return (
        <MessageInput
            className="w-full p-2 border rounded"
            defaultSingleLine={true}
            sendMessage={postComment}
            sendButtonText="Save"
            defaultValue={defaultValue}
        />
    );

}

function ArtifactWithComments({ artifact }: { artifact: SubmissionArtifact }) {
    return <Box borderWidth="1px" borderColor="border.emphasized" borderRadius="md" m={2}>
        <Box bg="bg.muted" p={2} borderBottom="1px solid" borderColor="border.emphasized">
            <HStack justifyContent="space-between">
                <Heading size="md">Artifact: {artifact.name}</Heading>
                <Button 
                variant="surface"
                colorPalette="green"
                onClick={() => {
                                const client = createClient();
                                const artifactKey = `classes/${artifact.class_id}/profiles/${artifact.profile_id ? artifact.profile_id : artifact.assignment_group_id}/submissions/${artifact.submission_id}/${artifact.id}`;
                                client.storage.from('submission-artifacts').createSignedUrl(artifactKey, 60 * 60 * 24 * 30).then((data) => {
                                    //Coerce download of the signed url
                                    const a = document.createElement('a');
                                    a.href = data?.data?.signedUrl || '';
                                    a.download = artifact.name;
                                    a.click();
                                });
                            }}>Download</Button>
            </HStack>
        </Box>
        <ArtifactView artifact={artifact} />
        <AritfactComments artifact={artifact} />
    </Box>
}
function ArtifactView({ artifact }: { artifact: SubmissionArtifact }) {
    //Load the artifact data from supabase
    const [artifactData, setArtifactData] = useState<Blob | null>(null);
    const [siteUrl, setSiteUrl] = useState<string | null>(null);
    const comments = useSubmissionArtifactComments({}).filter((comment) => comment.deleted_at === null && comment.submission_artifact_id === artifact.id);
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
                                }, { targetOrigin: '*' });
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
                            <Box borderWidth="1px" borderColor="border.emphasized" borderRadius="md" overflow="hidden">
                                <iframe
                                    src={siteUrl}
                                    style={{ width: '100%', height: '100%', border: 'none', minHeight: '500px' }}
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
                {(currentView === "file" && submission.submission_files[curFile]) && <CodeFile file={submission.submission_files[curFile]} />}
                {(currentView === "artifact" && submission.submission_artifacts[curArtifact]) && <ArtifactWithComments artifact={submission.submission_artifacts[curArtifact] as SubmissionArtifact} />}
            </Box>
        </Flex>
    </Box>
}
