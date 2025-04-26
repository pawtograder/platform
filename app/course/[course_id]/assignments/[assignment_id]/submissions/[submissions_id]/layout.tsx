'use client'
import { Button } from "@/components/ui/button";
import {
    PopoverArrow,
    PopoverBody,
    PopoverContent,
    PopoverRoot,
    PopoverTrigger
} from "@/components/ui/popover";
import { HydratedRubricCheck, HydratedRubricCriteria, LegacyRubricWithCriteriaAndChecks, Submission, SubmissionReviewWithRubric, SubmissionWithFilesGraderResultsOutputTestsAndRubric, SubmissionWithGraderResultsAndReview } from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Heading, HStack, List, Popover, Skeleton, Table, Text, VStack } from "@chakra-ui/react";

import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import { DataListItem, DataListRoot } from "@/components/ui/data-list";
import Link from "@/components/ui/link";
import PersonName from "@/components/ui/person-name";
import { RubricCriteria } from "@/components/ui/rubric-sidebar";
import { Toaster } from "@/components/ui/toaster";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { SubmissionProvider, useAllRubricCheckInstances, useRubricCriteriaInstances, useSubmission, useSubmissionReview, useSubmissionRubric } from "@/hooks/useSubmission";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { activateSubmission } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Icon } from "@chakra-ui/react";
import { useInvalidate, useList, useSubscription, useUpdate } from "@refinedev/core";
import { formatRelative } from "date-fns";
import NextLink from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { FaBell, FaCheckCircle, FaFile, FaHistory, FaQuestionCircle, FaTimesCircle } from "react-icons/fa";
import { useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import AskForHelpButton from "@/components/ui/ask-for-help-button";
import { CrudFilter } from "@refinedev/core";
function SubmissionHistory({ submission }: { submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric }) {
    const pathname = usePathname();
    const invalidate = useInvalidate();
    const router = useRouter();
    const [hasNewSubmission, setHasNewSubmission] = useState<boolean>(false);
    const groupOrProfileFilter : CrudFilter = submission.assignment_group_id ? {
        field: "assignment_group_id",
        operator: "eq",
        value: submission.assignment_group_id
    } : {
        field: "profile_id",
        operator: "eq",
        value: submission.profile_id
    }
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
            },
            groupOrProfileFilter
        ],
        sorters: [
            {
                field: "created_at",
                order: "desc"
            }
        ]
    });
    useList<Submission>({
        resource: "submissions",
        meta: {
            select: "*"
        },
        filters: [
            {
                field: "assignment_id",
                operator: "eq",
                value: submission.assignments.id
            }
        ],
        liveMode: "manual",
        onLiveEvent: (event) => {
            const newSubmission = event.payload as Submission;
            if (newSubmission.assignment_group_id === submission.assignment_group_id && newSubmission.profile_id === submission.profile_id) {
                setHasNewSubmission(true);
            }
            invalidate({ resource: "submissions", invalidates: ["list"] });
        }
    })
    const supabase = createClient();
    if (isLoading || !submission.assignments) {
        return <Skeleton height="20px" />
    }
    return <PopoverRoot>
        <PopoverTrigger asChild>
            <Button variant={hasNewSubmission ? "solid" : "outline"} colorPalette={hasNewSubmission ? "yellow" : "default"}>
                <Icon as={FaHistory} />
                Submission History
                {hasNewSubmission && <Icon as={FaBell} />}
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
                                            {historical_submission.is_active ? <>This submission is active</> : <Button variant="outline" size="xs" onClick={async () => {
                                                await activateSubmission({ submission_id: historical_submission.id }, supabase);
                                                invalidate({ resource: "submissions", invalidates: ["list"] });
                                                router.push(link);
                                            }}>
                                                <Icon as={FaCheckCircle} />
                                                Activate
                                            </Button>}
                                        </Table.Cell>
                                    </Table.Row>
                                )
                            })}
                        </Table.Body>
                    </Table.Root>
                </Box>
            </PopoverBody>
        </PopoverContent>
    </PopoverRoot>
}

function TestResults() {
    const submission = useSubmission();
    const testResults = submission.grader_results?.grader_result_tests;
    const totalScore = testResults?.reduce((acc, test) => acc + (test.score || 0), 0);
    const totalMaxScore = testResults?.reduce((acc, test) => acc + (test.max_score || 0), 0);
    const graderResultsMaxScore = submission.grader_results?.max_score;
    return <Box>
        <Heading size="md">Automated Check Results ({totalScore}/{totalMaxScore})</Heading>
        {(graderResultsMaxScore && totalMaxScore && graderResultsMaxScore > totalMaxScore) &&
            <Text color="text.muted" fontSize="sm">{graderResultsMaxScore - totalMaxScore} additional points are awarded by automated tests that are not shown until after grading is complete.</Text>}
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

function incompleteRubricChecks(rubric: LegacyRubricWithCriteriaAndChecks, comments: { rubric_check_id: number | null, submission_review_id: number | null }[]): {
    required_checks: HydratedRubricCheck[]
    optional_checks: HydratedRubricCheck[]
    required_criteria: {
        criteria: HydratedRubricCriteria,
        check_count_applied: number
    }[]
    optional_criteria: {
        criteria: HydratedRubricCriteria,
        check_count_applied: number
    }[]
} {
    const required_checks = rubric.rubric_criteria.flatMap((criteria) => criteria.rubric_checks.filter((check) =>
        check.is_required && !comments.some((comment) => comment.rubric_check_id === check.id)
    )) as HydratedRubricCheck[];
    const optional_checks = rubric.rubric_criteria.filter(criteria => criteria.min_checks_per_submission === null).flatMap((criteria) => criteria.rubric_checks.filter((check) =>
        !check.is_required && !comments.some((comment) => comment.rubric_check_id === check.id)
    )) as HydratedRubricCheck[];
    const criteria = rubric.rubric_criteria.map((criteria) => ({
        criteria: criteria as HydratedRubricCriteria,
        check_count_applied: criteria.rubric_checks.filter(
            (check) => comments.some((comment) => comment.rubric_check_id === check.id)).length
    }));
    const required_criteria = criteria.filter((criteria) => criteria.criteria.min_checks_per_submission !== null
        && criteria.check_count_applied < criteria.criteria.min_checks_per_submission);
    const optional_criteria = criteria.filter((criteria) => criteria.criteria.min_checks_per_submission === null
        && criteria.check_count_applied === 0);
    return {
        required_checks,
        optional_checks,
        required_criteria,
        optional_criteria
    }
}
function CompleteRubricButton() {
    const submission = useSubmission();
    const review = useSubmissionReview();
    const rubric = useSubmissionRubric();
    const comments = useAllRubricCheckInstances(review?.id);
    const { required_checks, optional_checks, required_criteria, optional_criteria } = incompleteRubricChecks(rubric!, comments);
    //   //TODO: Check if all required parts are graded, and show an error if not. 
    //             // If non-required parts are not graded, show a warning that the grader must click-through.
    //             if(required_checks.length > 0 || required_criteria.length > 0) {
    //                 toaster.create({
    //                     title: "Incomplete Rubric Checks",
    //                     description: "Please grade all required checks before marking the submission as graded.\n\nMissing checks: " + required_checks.map((check) => check.name).join(", ") + " and " + required_criteria.map((criteria) => criteria.criteria.name).join(", "),
    //                     type: "error"
    //                 });
    //                 console.log("Incomplete checks", required_checks, required_criteria);
    //             } else if (optional_checks.length > 0 || optional_criteria.length > 0) {
    //                 toaster.create({
    //                     title: "Incomplete Rubric Checks",
    //                     description: "Please grade all optional checks before marking the submission as graded.\n\nMissing checks: " + optional_checks.map((check) => check.name).join(", ") + " and " + optional_criteria.map((criteria) => criteria.criteria.name).join(", "),
    //                     type: "warning"
    //                 });
    //             } else {
    //                 // updateReview({ id: review.id, values: { completed_at: new Date(), completed_by: private_profile_id } });
    //                 console.log("Marking as graded");
    //             }
    const missingRequiredChecks = required_checks.length > 0 || required_criteria.length > 0;
    const missingOptionalChecks = optional_checks.length > 0 || optional_criteria.length > 0;
    const { mutateAsync: updateReview } = useUpdate<SubmissionReviewWithRubric>({
        resource: "submission_reviews",
    });
    const review_id = review?.id;
    const { private_profile_id } = useClassProfiles();
    return <Popover.Root>
        <Popover.Trigger asChild>
            <Button variant="surface">
                Mark as Graded
            </Button>
        </Popover.Trigger>
        <Popover.Positioner>
            <Popover.Content>
                <Popover.Arrow>
                    <Popover.ArrowTip />
                </Popover.Arrow>
                <Popover.Body bg={missingRequiredChecks ? "bg.error" : missingOptionalChecks ? "bg.warning" : "bg.success"} borderRadius="md">
                    <VStack align="start">
                        <Box w="100%">
                            <Heading size="md">
                                {missingRequiredChecks ? "Required Checks Missing" : missingOptionalChecks ? "Confirm that you have carefully reviewed the submission" : "Complete Grading"}
                            </Heading>
                        </Box>
                        {missingRequiredChecks && <Box>
                            <Heading size="sm">These checks are required. Please grade them before marking the submission as graded.</Heading>
                            <List.Root as="ol">
                                {required_checks.map((check) => <List.Item key={check.id}>{check.name}</List.Item>)}
                                {required_criteria.map((criteria) => <List.Item key={criteria.criteria.id}>{criteria.criteria.name} (select at least {criteria.criteria.min_checks_per_submission} checks)</List.Item>)}
                            </List.Root></Box>}
                        {missingOptionalChecks && <Box>
                            <Heading size="sm">These checks were not applied, but not required. Please take a quick look to make sure that you did not miss anything:</Heading>
                            <List.Root as="ol">
                                {optional_checks.map((check) => <List.Item key={check.id}>{check.name}</List.Item>)}
                                {optional_criteria.map((criteria) => <List.Item key={criteria.criteria.id}>{criteria.criteria.name} (select at least {criteria.criteria.min_checks_per_submission} checks)</List.Item>)}
                            </List.Root>
                        </Box>}
                        {(!missingRequiredChecks && !missingOptionalChecks) && <Text>All checks have been graded. Click the button below to mark the submission as graded.</Text>}
                        {!missingRequiredChecks && <Button variant="solid" colorPalette="green" onClick={() => {
                            updateReview({ id: review!.id, values: { completed_at: new Date(), completed_by: private_profile_id } });
                        }}>Mark as Graded</Button>}
                    </VStack>
                </Popover.Body>
            </Popover.Content>
        </Popover.Positioner>
    </Popover.Root>
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
        <Toaster />
        <ReviewStats />
        <HStack>
            {!review.completed_at && <CompleteRubricButton />}
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
    const criteria = submission.assignments.rubrics?.rubric_criteria as HydratedRubricCriteria[];
    const comments = useAllRubricCheckInstances(review?.id);
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
                    <HStack gap={1}>
                        <Link href={`https://github.com/${submission.repository}/commit/${submission.sha}`} target="_blank">Commit {submission.sha.substring(0, 7)}</Link>
                        <Link href={`https://github.com/${submission.repository}/archive/${submission.sha}.zip`} target="_blank">(Download)</Link>
                    </HStack>
                </VStack>
            </Box>
            <HStack>
                <AskForHelpButton />
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
                <Box flex={10} pr={4}>
                    {children}
                </Box>
                <Box flex={0}>
                    <RubricView />
                </Box>
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