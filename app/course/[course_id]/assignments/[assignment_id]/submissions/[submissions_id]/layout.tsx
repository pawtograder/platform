'use client'
import { Button } from "@/components/ui/button";
import {
    PopoverArrow,
    PopoverBody,
    PopoverContent,
    PopoverRoot,
    PopoverTrigger
} from "@/components/ui/popover";
import { RubricChecks, RubricCriteriaWithRubricChecks, SubmissionComments, SubmissionFileComment, SubmissionReviewWithRubric, SubmissionWithFilesGraderResultsOutputTestsAndRubric, SubmissionWithGraderResultsAndReview } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Heading, HStack, Menu, Portal, RadioGroup, Skeleton, Table, Text, VStack } from "@chakra-ui/react";

import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { Checkbox } from "@/components/ui/checkbox";
import { DataListItem, DataListRoot } from "@/components/ui/data-list";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import MessageInput from "@/components/ui/message-input";
import PersonName from "@/components/ui/person-name";
import { Radio } from "@/components/ui/radio";
import { Tooltip } from "@/components/ui/tooltip";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { SubmissionProvider, useRubricCheckInstances, useRubricCriteriaInstances, useSubmission, useSubmissionReview } from "@/hooks/useSubmission";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { activateSubmission } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Icon } from "@chakra-ui/react";
import { useCreate, useInvalidate, useList, useUpdate } from "@refinedev/core";
import { formatRelative } from "date-fns";
import NextLink from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import path from "path";
import { useEffect, useRef, useState } from "react";
import { BsFileEarmarkCodeFill, BsThreeDots } from "react-icons/bs";
import { FaCheckCircle, FaFile, FaHistory, FaQuestionCircle, FaTimesCircle } from "react-icons/fa";

function SubmissionHistory({ submission }: { submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric }) {
    const pathname = usePathname();
    const invalidate = useInvalidate();
    const router = useRouter();
    const { data, isLoading } = useList<SubmissionWithGraderResultsAndReview>({
        resource: "submissions",
        meta: {
            select: "*, assignments(*), grader_results(*), submission_reviews!submissions_grading_review_id_fkey(*)"
        },
        filters: [
            {
                field: "assignment_id",
                operator: "eq",
                value: submission.assignments.id
            }
        ],
        sorters: [
            {
                field: "created_at",
                order: "desc"
            }
        ]
    });
    const supabase = createClient();
    if (isLoading || !submission.assignments) {
        return <Skeleton height="20px" />
    }
    return <PopoverRoot>
        <PopoverTrigger asChild>
            <Button variant="outline">
                <Icon as={FaHistory} />
                Submission History
            </Button>
        </PopoverTrigger>
        <PopoverContent width="lg">
            <PopoverArrow />
            <PopoverBody>
                <Text>Submission History</Text>
                <Box maxHeight="400px" overflowY="auto" css={{
                    '&::-webkit-scrollbar': {
                        width: '8px',
                    },
                    '&::-webkit-scrollbar-track': {
                        background: '#f1f1f1',
                        borderRadius: '4px',
                    },
                    '&::-webkit-scrollbar-thumb': {
                        background: '#888',
                        borderRadius: '4px',
                    },
                    '&::-webkit-scrollbar-thumb:hover': {
                        background: '#555',
                    }
                }}>
                    <Table.Root> 
                        <Table.Header> 
                            <Table.Row>
                                <Table.ColumnHeader>#</Table.ColumnHeader>
                                <Table.ColumnHeader>Date</Table.ColumnHeader>
                                <Table.ColumnHeader>Auto Grader Score</Table.ColumnHeader>
                                <Table.ColumnHeader>Total Score</Table.ColumnHeader>
                                <Table.ColumnHeader>Actions</Table.ColumnHeader>
                            </Table.Row>
                        </Table.Header>
                        <Table.Body> 
                            {data?.data.map((historical_submission) => {
                               const link = `/course/${historical_submission.class_id}/assignments/${historical_submission.assignment_id}/submissions/${historical_submission.id}`;
                                return (
                                <Table.Row key={historical_submission.id} bg={pathname.startsWith(link) ? "bg.emphasized" : undefined}>
                                    <Table.Cell>
                                        <Link href={link}> 
                                            {historical_submission.is_active && <ActiveSubmissionIcon />}
                                            {historical_submission.ordinal}
                                        </Link>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Link href={link}>
                                            {formatRelative(historical_submission.created_at, new Date())}
                                        </Link>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Link href={link}>
                                            {historical_submission.grader_results?.score !== undefined ? historical_submission.grader_results?.score + "/" + historical_submission.grader_results?.max_score : "Error"}
                                        </Link>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Link href={link}>
                                            {historical_submission.submission_reviews?.completed_at && historical_submission.submission_reviews?.total_score + "/" + historical_submission.assignments.total_points}
                                        </Link>
                                    </Table.Cell>
                                    <Table.Cell>
                                        {historical_submission.is_active ? <>This submission is active</> :<Button variant="outline" size="xs" onClick={async () => {
                                            await activateSubmission({ submission_id: historical_submission.id }, supabase);
                                            invalidate({ resource: "submissions", invalidates: ["list"] });
                                            router.push(link);
                                        }}>
                                            <Icon as={FaCheckCircle} />
                                            Activate
                                        </Button>}
                                    </Table.Cell>
                                </Table.Row>
                            )})}
                        </Table.Body>
                    </Table.Root>
                </Box>
            </PopoverBody>
        </PopoverContent>
    </PopoverRoot>
}
function isLineComment(comment: SubmissionFileComment | SubmissionComments): comment is SubmissionFileComment {
    return 'line' in comment;
}
function SubmissionFileCommentLink({ comment }: { comment: SubmissionFileComment }) {
    const submission = useSubmission();
    const file = submission.submission_files.find((file) => file.id === comment.submission_file_id);
    if (!file) {
        return <></>;
    }
    const shortFileName = path.basename(file.name);
    return <Link href={`/course/${comment.class_id}/assignments/${submission.assignment_id}/submissions/${comment.submission_id}/files/?file_id=${comment.submission_file_id}#L${comment.line}`}>@ {shortFileName}:{comment.line}</Link>
}
function CommentActions({ comment, setIsEditing }: { comment: SubmissionFileComment | SubmissionComments, setIsEditing: (isEditing: boolean) => void }) {
    const { private_profile_id } = useClassProfiles();
    const { mutateAsync: updateComment } = useUpdate({
        resource: isLineComment(comment) ? "submission_file_comments" : "submission_comments",
    });
    return <Menu.Root onSelect={async (value) => {
        if (value.value === "edit") {
            setIsEditing(true);
        }
        else if (value.value === "delete") {
            await updateComment({
                id: comment.id,
                values: {
                    edited_by: private_profile_id,
                    deleted_at: new Date()
                }
            });
        }
    }}>
        <Menu.Trigger asChild>
            <Button colorPalette="blue" variant="ghost" size="xs"><Icon as={BsThreeDots} /></Button>
        </Menu.Trigger>
        <Portal>
            <Menu.Positioner>
                <Menu.Content>
                    <Menu.Item value="edit">Edit</Menu.Item>
                    <Menu.Item value="delete">Delete</Menu.Item>
                </Menu.Content>
            </Menu.Positioner>
        </Portal>
    </Menu.Root>
}
function RubricCheckComment({ comment, criteria }: { comment: SubmissionFileComment | SubmissionComments, criteria: RubricCriteriaWithRubricChecks }) {
    const author = useUserProfile(comment.author);
    const [isEditing, setIsEditing] = useState(false);
    const messageInputRef = useRef<HTMLTextAreaElement>(null);
    const { mutateAsync: updateComment } = useUpdate({
        resource: isLineComment(comment) ? "submission_file_comments" : "submission_comments",
    });
    return <Box border="1px solid" borderColor="border.info" borderRadius="md" p={0} w="100%"
        fontSize="sm">
        <Box bg="bg.info" pl={1} borderTopRadius="md">
            <HStack justify="space-between">
                <Text fontSize="sm" color="fg.muted">{author?.name} applied {formatRelative(comment.created_at, new Date())}</Text>
                <CommentActions comment={comment} setIsEditing={setIsEditing} />
            </HStack>
        </Box>
        <Box
            ml={1}
            color="fg.muted">
            <HStack gap={1}>
                {criteria.is_additive ? <><Icon as={FaCheckCircle} color="green.500" />+{comment.points}</> : <><Icon as={FaTimesCircle} color="red.500" />-{comment.points}</>} {isLineComment(comment) && <SubmissionFileCommentLink comment={comment} />}
            </HStack>
            {isEditing ? <MessageInput
                textAreaRef={messageInputRef}
                defaultSingleLine={true}
                value={comment.comment}
                closeButtonText="Cancel"
                onClose={() => {
                    setIsEditing(false);
                }}
                sendButtonText="Save"
                sendMessage={async (message, profile_id) => {
                    await updateComment({
                        id: comment.id,
                        values: { comment: message }
                    });
                    setIsEditing(false);
                }}
            /> : <Markdown>{comment.comment}</Markdown>}
        </Box>
    </Box>
}
function RubricCheckAnnotation({ check, criteria }: { check: RubricChecks, criteria: RubricCriteriaWithRubricChecks }) {
    const review = useSubmissionReview();
    const rubricCheckComments = useRubricCheckInstances(check, review?.id);
    return <>
        <HStack>
            <Tooltip content="This check is an annotation, it can only be applied by clicking on a specific line of code.">
                <Icon as={BsFileEarmarkCodeFill} size="xs" />
            </Tooltip>
            <Text>{check.name}</Text>
        </HStack>
        <Markdown style={{
            fontSize: "0.8rem",
        }}>{check.description}</Markdown>
        {rubricCheckComments.map((comment) => <RubricCheckComment key={comment.id} comment={comment} criteria={criteria} />)}
    </>
}
function SubmissionCommentForm({ check, criteria }: { check: RubricChecks, criteria: RubricCriteriaWithRubricChecks }) {
    const messageInputRef = useRef<HTMLTextAreaElement>(null);
    const review = useSubmissionReview();
    const submission = useSubmission();
    const { mutateAsync: createComment } = useCreate({
        resource: "submission_comments",
    })
    useEffect(() => {
        if (messageInputRef.current) {
            messageInputRef.current.focus();
        }
    }, []);
    return <Box>
        <MessageInput
            textAreaRef={messageInputRef}
            sendButtonText="Add Check"
            placeholder={
                check.is_comment_required ? "Add a comment about this check and press enter to submit..." : "Optionally add a comment, or just press enter to submit..."
            }
            sendMessage={async (message, profile_id) => {
                const values = {
                    comment: message || '',
                    rubric_check_id: check.id,
                    class_id: submission.class_id,
                    submission_id: submission.id,
                    author: profile_id,
                    points: check.points,
                    released: false,
                    submission_review_id: review!.id
                }
                await createComment({ values });
            }}
            defaultSingleLine={true}
            allowEmptyMessage={!check.is_comment_required}
        />
    </Box>
}
function RubricCheckGlobal({ check, criteria, isSelected }: { check: RubricChecks, criteria: RubricCriteriaWithRubricChecks, isSelected: boolean }) {
    const review = useSubmissionReview();
    const rubricCheckComments = useRubricCheckInstances(check, review?.id);
    const criteriaCheckComments = useRubricCriteriaInstances({ criteria, review_id: review?.id });
    const [selected, setSelected] = useState<boolean>(rubricCheckComments.length > 0);
    const [isEditing, setIsEditing] = useState<boolean>(isSelected && rubricCheckComments.length === 0);
    useEffect(() => {
        setSelected(rubricCheckComments.length > 0);
    }, [rubricCheckComments.length]);
    useEffect(() => {
        setIsEditing(isSelected && rubricCheckComments.length === 0 && criteria.max_checks_per_submission != criteriaCheckComments.length);
    }, [isSelected, rubricCheckComments.length, criteria.max_checks_per_submission, criteriaCheckComments.length]);

    const points = criteria.is_additive ? `+${check.points}` : `-${check.points}`;
    return <>
        <HStack>
            {criteria.max_checks_per_submission != 1 ? <Checkbox
                disabled={rubricCheckComments.length > 0}
                checked={selected} onCheckedChange={(newState) => {
                    setSelected(newState.checked ? true : false);
                }}>
                <Text>{points} {check.name}</Text>
            </Checkbox> : <Radio value={check.id.toString()} disabled={rubricCheckComments.length > 0}>
                <Text>{points} {check.name}</Text>
            </Radio>}
        </HStack>
        <Markdown style={{
            fontSize: "0.8rem",
        }}>{check.description}</Markdown>
        {isEditing && <SubmissionCommentForm check={check} criteria={criteria} />}
        {rubricCheckComments.map((comment) => <RubricCheckComment key={comment.id} comment={comment} criteria={criteria} />)}
    </>
}
function RubricCheck({ criteria, check, isSelected }: { criteria: RubricCriteriaWithRubricChecks, check: RubricChecks, isSelected: boolean }) {
    return <Box border="1px solid" borderColor="border.emphasized" borderRadius="md" p={1} w="100%">
        {check.is_annotation ? <RubricCheckAnnotation check={check} criteria={criteria} /> : <RubricCheckGlobal check={check} criteria={criteria} isSelected={isSelected} />}
    </Box>
}

function RubricCriteria({ criteria }: { criteria: RubricCriteriaWithRubricChecks }) {
    const submission = useSubmission();
    const review = useSubmissionReview();
    const comments = useRubricCriteriaInstances({ criteria, review_id: review?.id });
    const totalPoints = comments.reduce((acc, comment) => acc + (comment.points || 0), 0);
    const isAdditive = criteria.is_additive;
    const [selectedCheck, setSelectedCheck] = useState<RubricChecks>();
    let pointsText = '';
    if (isAdditive) {
        pointsText = `${totalPoints}/${criteria.total_points}`;
    } else {
        pointsText = `${criteria.total_points - totalPoints}/${criteria.total_points}`;
    }
    const gradingIsRequired = comments.length < (criteria.min_checks_per_submission || 0);
    let instructions = "";
    if (criteria.min_checks_per_submission) {
        if (criteria.max_checks_per_submission) {
            if (criteria.min_checks_per_submission === criteria.max_checks_per_submission) {
                instructions = `Select ${criteria.min_checks_per_submission} check${criteria.min_checks_per_submission === 1 ? "" : "s"}`;
            } else {
                instructions = `Select ${criteria.min_checks_per_submission} - ${criteria.max_checks_per_submission} checks`;
            }
        } else {
            instructions = `Select at least ${criteria.min_checks_per_submission} checks`;
        }
    } else if (criteria.max_checks_per_submission) {
        instructions = `Select at most ${criteria.max_checks_per_submission} checks`;
    }
    const singleCheck = criteria.max_checks_per_submission === 1 && comments.length === 1 ? comments[0].rubric_check_id?.toString() : undefined;
    return <Box border="1px solid" borderColor={gradingIsRequired ? "border.error" : "border.emphasized"} borderRadius="md" p={2} w="100%"
    >
        <Heading size="md">{criteria.name} {pointsText}</Heading>
        <Markdown style={{
            fontSize: "0.8rem",
        }}>{criteria.description}</Markdown>
        <VStack align="flex-start" w="100%" gap={0}>
            <Heading size="sm">Checks</Heading>
            <Text fontSize="sm" color={gradingIsRequired ? "fg.error" : "fg.muted"}>{instructions}</Text>
            <RadioGroup.Root
                value={singleCheck}
                onValueChange={(value) => {
                    setSelectedCheck(criteria.rubric_checks.find((check) => check.id.toString() === value.value));
                }}>
                {criteria.rubric_checks.map((check) => <RubricCheck key={check.id} criteria={criteria} check={check} isSelected={selectedCheck?.id === check.id} />)}
            </RadioGroup.Root>
        </VStack>
    </Box>
}
function TestResults() {
    const submission = useSubmission();
    const testResults = submission.grader_results?.grader_result_tests;
    const totalScore = testResults?.reduce((acc, test) => acc + (test.score || 0), 0);
    const totalMaxScore = testResults?.reduce((acc, test) => acc + (test.max_score || 0), 0);
    return <Box>
        <Heading size="md">Automated Check Results ({totalScore}/{totalMaxScore})</Heading>
        {testResults?.map((test) => <Box key={test.id} border="1px solid" borderColor="border.emphasized" borderRadius="md" p={1} w="100%">
            {test.score == test.max_score ? <Icon as={FaCheckCircle} color="green.500" /> : <Icon as={FaTimesCircle} color="red.500" />}
            <Link href={`/course/${submission.class_id}/assignments/${submission.assignments.id}/submissions/${submission.id}/results#test-${test.id}`}><Heading size="sm">{test.name} {test.score}/{test.max_score}</Heading></Link>
        </Box>)}
    </Box>
}
function ReviewStats() {
    const submission = useSubmission();
    const review = useSubmissionReview();
    const { checked_by, completed_by, checked_at, completed_at } = review || {};
    const allRubricInstances = useRubricCriteriaInstances({
        review_id: review?.id,
        rubric_id: submission.assignments.rubrics?.id
    });
    const allGraders = new Set<string>();
    for (const instance of allRubricInstances) {
        allGraders.add(instance.author);
    }
    if (completed_by) {
        allGraders.delete(completed_by);
    }
    if (checked_by) {
        allGraders.delete(checked_by);
    }
    const mostRecentCreationOrEdit = allRubricInstances.reduce((acc, instance) => {
        return Math.max(acc, Date.parse(instance.created_at), Date.parse(instance.edited_at || ""));
    }, 0);
    const mostRecentGrader = allRubricInstances.find((instance) => Date.parse(instance.created_at) === mostRecentCreationOrEdit)?.author;
    if (!review) {
        return <Skeleton height="20px" />
    }
    return <DataListRoot orientation="horizontal">
        <DataListItem label="Released to student" value={review.released ? "Yes" : "No"} />
        {completed_by && <DataListItem label="Completed by" value={<PersonName size="2xs" uid={completed_by} />} />}
        {completed_at && <DataListItem label="Completed at" value={formatRelative(completed_at, new Date())} />}
        {checked_by && <DataListItem label="Checked by" value={<PersonName size="2xs" uid={checked_by} />} />}
        {checked_at && <DataListItem label="Checked at" value={formatRelative(checked_at, new Date())} />}
        {mostRecentGrader && <DataListItem label="Last updated by" value={<PersonName size="2xs" uid={mostRecentGrader} />} />}
        {allGraders.size > 0 && <DataListItem label="Other graders" value={Array.from(allGraders).map((grader) => <PersonName size="2xs" key={grader} uid={grader} />)} />}
    </DataListRoot>
}
function ReviewActions() {
    const review = useSubmissionReview();
    const { private_profile_id } = useClassProfiles();
    const { mutateAsync: updateReview } = useUpdate<SubmissionReviewWithRubric>({
        resource: "submission_reviews",
    });
    if (!review) {
        return <Skeleton height="20px" />
    }
    return <VStack>
        <ReviewStats />
        <HStack>
            {!review.completed_at && <Button variant="surface" onClick={() => {
                updateReview({ id: review.id, values: { completed_at: new Date(), completed_by: private_profile_id } });
            }}>Mark as Graded</Button>}
            {(review.completed_at && !review.checked_at && private_profile_id !== review.completed_by) && <Button variant="surface" onClick={() => {
                updateReview({ id: review.id, values: { checked_at: new Date(), checked_by: private_profile_id } });
            }}>Mark as Checked</Button>}
            {review.released ? <Button variant="surface" onClick={() => {
                updateReview({ id: review.id, values: { released: false } });
            }}>Unrelease</Button> : <Button variant="surface" onClick={() => {
                updateReview({ id: review.id, values: { released: true } });
            }}>Release To Student</Button>}
        </HStack>
    </VStack>
}
function RubricView() {
    const submission = useSubmission();
    const isGraderOrInstructor = useIsGraderOrInstructor();
    const review = useSubmissionReview();
    const showHandGrading = isGraderOrInstructor || review?.released;
    const criteria = submission.assignments.rubrics?.rubric_criteria;
    // rubrics.sort((a, b) => a.name.localeCompare(b.name));
    return <Box
        position="sticky"
        top="0"
        borderLeftWidth="1px"
        borderColor="border.emphasized"
        p={2}
        ml={0}
        height="100vh"
        overflowY="auto"
    >
        <VStack align="start" w="md">
            {review && <Heading size="xl">Grading Summary ({review?.total_score}/{submission.assignments.total_points})</Heading>}
            {isGraderOrInstructor && <ReviewActions />}
            <TestResults />
            {showHandGrading && <Heading size="md">Hand Check Results</Heading>}
            {showHandGrading && criteria?.map((criteria) => <RubricCriteria key={criteria.id} criteria={criteria} />)}
        </VStack>

        {!review && <Text>This submission has not been hand-graded yet.
            {(submission.assignments.autograder_points && submission.assignments.total_points) && <>The hand-graded portion will account for {submission.assignments.total_points - submission.assignments.autograder_points} points.</>}
        </Text>}

    </Box>

}

function SubmissionsLayout({ children }: { children: React.ReactNode }) {
    const { submissions_id } = useParams();
    const pathname = usePathname();
    const submission = useSubmission();
    const submitter = useUserProfile(submission.profile_id);
    return <Flex direction="column" borderColor="border.muted"
        borderWidth="2px"
        borderRadius="md"
    >
        <HStack pl={4} pr={4} alignItems="center" justify="space-between" align="center">
            <Box><Heading size="lg">{submission.assignments.title} - Submission #{submission.ordinal}</Heading>
                <VStack align="flex-start">
                    <HStack gap={1}>
                        {submission.is_active && <ActiveSubmissionIcon />}
                        {submission.assignment_groups ? <Text>Group {submission.assignment_groups.name} ({submission.assignment_groups.assignment_groups_members.map((member) => member.profiles!.name).join(", ")})</Text> : <Text>{submitter?.name}</Text>}
                    </HStack>
                    <Link href={`https://github.com/${submission.repository}/commit/${submission.sha}`} target="_blank">Commit {submission.sha.substring(0, 7)}</Link>
                </VStack>
            </Box>
            <HStack>
                <Button variant="surface" onClick={() => {
                    // toaster({
                    //     title: "Ask For Help",
                    //     description: "This feature is not yet implemented.",
                    //     status: "info"
                    // });
                }}>
                    <Icon as={FaQuestionCircle} />
                    Ask For Help
                </Button>
                <SubmissionHistory submission={submission} />
            </HStack>
        </HStack>
        <Text textStyle="sm" color="text.muted">
        </Text>
        <Box
            p={0}
            m={0}
            borderBottomColor="border.emphasized"
            borderBottomWidth="2px"
            bg="bg.muted"
            defaultValue="results">
            <NextLink prefetch={true} href={`/course/${submission.class_id}/assignments/${submission.assignments.id}/submissions/${submission.id}/results`}>
                <Button variant={pathname.includes("/results") ? "solid" : "ghost"}>
                    <Icon as={FaCheckCircle} />
                    Grading Summary
                </Button>
            </NextLink>
            <NextLink prefetch={true} href={`/course/${submission.class_id}/assignments/${submission.assignments.id}/submissions/${submission.id}/files`}>
                <Button variant={pathname.includes("/files") ? "solid" : "ghost"}>
                    <Icon as={FaFile} />
                    Files
                </Button>
            </NextLink>
        </Box>
        <Box flex={1}>
            <Flex>
                <Box>
                    {children}
                </Box>
                <RubricView />
            </Flex>
        </Box>
    </Flex>
}

export default function SubmissionsLayoutWrapper({ children }: { children: React.ReactNode }) {
    const { submissions_id } = useParams();
    return <SubmissionProvider submission_id={Number(submissions_id)}>
        <SubmissionsLayout>{children}</SubmissionsLayout>
    </SubmissionProvider>
}