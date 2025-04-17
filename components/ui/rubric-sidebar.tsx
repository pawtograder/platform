'use client'
import { Button } from "@/components/ui/button";
import {
    PopoverArrow,
    PopoverBody,
    PopoverContent,
    PopoverRoot,
    PopoverTrigger
} from "@/components/ui/popover";
import { HydratedRubric, HydratedRubricCheck, HydratedRubricCriteria, HydratedRubricPart, RubricChecks, RubricCriteriaWithRubricChecks, SubmissionComments, SubmissionFileComment, SubmissionReviewWithRubric, SubmissionWithFilesGraderResultsOutputTestsAndRubric, SubmissionWithGraderResultsAndReview } from "@/utils/supabase/DatabaseTypes";
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
export function CommentActions({ comment, setIsEditing }: { comment: SubmissionFileComment | SubmissionComments, setIsEditing: (isEditing: boolean) => void }) {
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
            <Button 
            p={0}
            m={0}
            colorPalette="blue" variant="ghost" size="2xs"><Icon as={BsThreeDots} /></Button>
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

export function isLineComment(comment: SubmissionFileComment | SubmissionComments): comment is SubmissionFileComment {
    return 'line' in comment;
}
export function SubmissionFileCommentLink({ comment }: { comment: SubmissionFileComment }) {
    const submission = useSubmission();
    const file = submission.submission_files.find((file) => file.id === comment.submission_file_id);
    if (!file) {
        return <></>;
    }
    const shortFileName = path.basename(file.name);
    return <Link href={`/course/${comment.class_id}/assignments/${submission.assignment_id}/submissions/${comment.submission_id}/files/?file_id=${comment.submission_file_id}#L${comment.line}`}>@ {shortFileName}:{comment.line}</Link>
}
export function RubricCheckComment({ comment, criteria }: { comment: SubmissionFileComment | SubmissionComments, criteria: HydratedRubricCriteria }) {
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

export function RubricCheckAnnotation({ check, criteria }: { check: HydratedRubricCheck, criteria: HydratedRubricCriteria }) {
    const review = useSubmissionReview();
    const rubricCheckComments = useRubricCheckInstances(check as RubricChecks, review?.id);
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
        {check.data?.options && <VStack align="flex-start" w="100%" gap={0}>
            {check.data.options.map((option, index) => <Radio
                disabled={rubricCheckComments.length > 0 || !review}
                key={option.label+"-"+index} value={option.points.toString()}>{option.label} ({criteria.is_additive ? "+" : "-"}{option.points})</Radio>)}
        </VStack>}
        {rubricCheckComments.map((comment) => <RubricCheckComment key={comment.id} comment={comment} criteria={criteria} />)}
    </>
}

export function RubricCheckGlobal({ check, criteria, isSelected }: { check: HydratedRubricCheck, criteria: HydratedRubricCriteria, isSelected: boolean }) {
    const review = useSubmissionReview();
    const rubricCheckComments = useRubricCheckInstances(check as RubricChecks, review?.id);
    const criteriaCheckComments = useRubricCriteriaInstances({ criteria: criteria as RubricCriteriaWithRubricChecks, review_id: review?.id });
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
                disabled={rubricCheckComments.length > 0 || !review}
                checked={selected} onCheckedChange={(newState) => {
                    if (newState.checked) {
                        setIsEditing(true);
                    } else {
                        setIsEditing(false);
                    }
                    setSelected(newState.checked ? true : false);
                }}>
                <Text>{points} {check.name}</Text>
            </Checkbox> : <Radio value={check.id.toString()} disabled={rubricCheckComments.length > 0 || !review}>
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
function SubmissionCommentForm({ check, criteria }: { check: HydratedRubricCheck, criteria: HydratedRubricCriteria }) {
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
    return <Box border="1px solid" borderColor="border.inverted" borderRadius="md" p={0} w="100%"
        fontSize="sm">
        <Box bg="bg.inverted" pl={1} borderTopRadius="md">
            <Text color="fg.inverted">Check not yet applied. {check.is_comment_required ? "A comment is required." : "Comment is optional, enter to add."}</Text>
        </Box>
        <MessageInput
            placeholder={
                "Comment"
            }
            sendButtonText="Add Check"
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
function RubricCheck({ criteria, check, isSelected }: { criteria: HydratedRubricCriteria, check: HydratedRubricCheck, isSelected: boolean }) {
    return <Box border="1px solid" borderColor="border.emphasized" borderRadius="md" p={1} w="100%">
        {check.is_annotation ? <RubricCheckAnnotation check={check} criteria={criteria} /> : <RubricCheckGlobal check={check} criteria={criteria} isSelected={isSelected} />}
    </Box>
}

export function RubricCriteria({ criteria }: { criteria: HydratedRubricCriteria }) {
    const review = useSubmissionReview();
    const comments = useRubricCriteriaInstances({ criteria: criteria as RubricCriteriaWithRubricChecks, review_id: review?.id });
    const totalPoints = comments.reduce((acc, comment) => acc + (comment.points || 0), 0);
    const isAdditive = criteria.is_additive;
    const [selectedCheck, setSelectedCheck] = useState<HydratedRubricCheck>();
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

export function RubricPart({ part }: { part: HydratedRubricPart }) {
    return <Box>
        <Heading size="md">{part.name}</Heading>
        <Markdown>{part.description}</Markdown>
        <VStack align="start" w="md">
            {part.rubric_criteria.sort((a, b) => a.ordinal - b.ordinal).map((criteria) => <RubricCriteria key={criteria.id} criteria={criteria} />)}
        </VStack>
    </Box>
}

export function RubricSidebar({ rubric, }: { rubric: HydratedRubric }) {
    return <Box
        borderLeftWidth="1px"
        borderColor="border.emphasized"
        p={2}
        ml={0}
        w="lg"
        height="100vh"
        overflowY="auto"
    >
        <VStack align="start" w="md">
            <Heading size="xl">Grading Summary</Heading>
            {rubric.rubric_parts.sort((a, b) => a.ordinal - b.ordinal).map((part) => <RubricPart key={part.id} part={part} />)}
        </VStack>
    </Box>
}

export default RubricSidebar;