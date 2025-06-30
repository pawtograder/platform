"use client";
import { Button } from "@/components/ui/button";
import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import type {
  Submission,
  SubmissionReviewWithRubric,
  SubmissionWithFilesGraderResultsOutputTestsAndRubric,
  SubmissionWithGraderResultsAndReview
} from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Heading, HStack, List, Skeleton, Table, Text, VStack } from "@chakra-ui/react";

import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import AskForHelpButton from "@/components/ui/ask-for-help-button";
import { DataListItem, DataListRoot } from "@/components/ui/data-list";
import Link from "@/components/ui/link";
import PersonName from "@/components/ui/person-name";
import { ListOfRubricsInSidebar, RubricCheckComment } from "@/components/ui/rubric-sidebar";
import SubmissionReviewToolbar, { CompleteReviewButton } from "@/components/ui/submission-review-toolbar";
import { Toaster } from "@/components/ui/toaster";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useCourse } from "@/hooks/useCourseController";
import {
  SubmissionProvider,
  useReviewAssignment,
  useRubricCriteriaInstances,
  useSubmission,
  useSubmissionComments,
  useSubmissionReviewOrGradingReview
} from "@/hooks/useSubmission";
import { useActiveReviewAssignmentId } from "@/hooks/useSubmissionReview";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { activateSubmission } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Icon } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { CrudFilter, useInvalidate, useList, useUpdate } from "@refinedev/core";
import { formatRelative } from "date-fns";
import NextLink from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ElementType as ReactElementType, useRef, useState } from "react";
import { BsFileEarmarkCodeFill, BsThreeDots } from "react-icons/bs";
import { FaBell, FaCheckCircle, FaFile, FaHistory, FaInfo, FaQuestionCircle, FaTimesCircle } from "react-icons/fa";
import { FiDownloadCloud, FiRepeat, FiSend } from "react-icons/fi";
import { HiOutlineInformationCircle } from "react-icons/hi";
import { LuMoon, LuSun } from "react-icons/lu";
import { PiSignOut } from "react-icons/pi";
import { RxQuestionMarkCircled } from "react-icons/rx";
import { TbMathFunction } from "react-icons/tb";
import type { GraderResultTestData } from "./results/page";
import { linkToSubPage } from "./utils";
import { formatDueDateInTimezone } from "@/lib/utils";

// Create a mapping of icon names to their components
const iconMap: { [key: string]: ReactElementType } = {
  FaBell,
  FaCheckCircle,
  FaFile,
  FaHistory,
  FaQuestionCircle,
  FaTimesCircle,
  BsFileEarmarkCodeFill,
  BsThreeDots,
  HiOutlineInformationCircle,
  LuMoon,
  FaInfo,
  LuSun,
  TbMathFunction,
  RxQuestionMarkCircled,
  FiDownloadCloud,
  FiRepeat,
  FiSend,
  PiSignOut
};

function SubmissionHistory({ submission }: { submission: SubmissionWithFilesGraderResultsOutputTestsAndRubric }) {
  const pathname = usePathname();
  const invalidate = useInvalidate();
  const router = useRouter();
  const [hasNewSubmission, setHasNewSubmission] = useState<boolean>(false);
  const groupOrProfileFilter: CrudFilter = submission.assignment_group_id
    ? {
        field: "assignment_group_id",
        operator: "eq",
        value: submission.assignment_group_id
      }
    : {
        field: "profile_id",
        operator: "eq",
        value: submission.profile_id
      };
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
      if (
        newSubmission.assignment_group_id === submission.assignment_group_id &&
        newSubmission.profile_id === submission.profile_id &&
        newSubmission.id !== submission.id &&
        newSubmission.is_active
      ) {
        setHasNewSubmission(true);
      }
      invalidate({ resource: "submissions", invalidates: ["list"] });
    }
  });
  const { time_zone } = useCourse();
  const supabase = createClient();
  const isGraderInterface = pathname.includes("/grade");
  if (isLoading || !submission.assignments) {
    return <Skeleton height="20px" />;
  }
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button variant={hasNewSubmission ? "solid" : "outline"} colorPalette={hasNewSubmission ? "yellow" : "default"}>
          <Icon as={FaHistory} />
          Submission History
          {hasNewSubmission && <Icon as={FaBell} />}
        </Button>
      </PopoverTrigger>
      <PopoverContent minWidth={{ base: "none", md: "lg" }}>
        <PopoverArrow />
        <PopoverBody>
          <Text>Submission History</Text>
          <Box
            maxHeight="400px"
            overflowY="auto"
            css={{
              "&::-webkit-scrollbar": {
                width: "8px"
              },
              "&::-webkit-scrollbar-track": {
                background: "#f1f1f1",
                borderRadius: "4px"
              },
              "&::-webkit-scrollbar-thumb": {
                background: "#888",
                borderRadius: "4px"
              },
              "&::-webkit-scrollbar-thumb:hover": {
                background: "#555"
              }
            }}
          >
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
                  const link = isGraderInterface
                    ? `/course/${historical_submission.class_id}/grade/assignments/${historical_submission.assignment_id}/submissions/${historical_submission.id}`
                    : `/course/${historical_submission.class_id}/assignments/${historical_submission.assignment_id}/submissions/${historical_submission.id}`;
                  return (
                    <Table.Row
                      key={historical_submission.id}
                      bg={pathname.startsWith(link) ? "bg.emphasized" : undefined}
                    >
                      <Table.Cell>
                        <Link href={link}>
                          {historical_submission.is_active && <ActiveSubmissionIcon />}
                          {historical_submission.ordinal}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <Link href={link}>
                          {formatRelative(
                            new TZDate(
                              historical_submission.created_at || new Date().toUTCString(),
                              time_zone || "America/New_York"
                            ),
                            TZDate.tz(time_zone || "America/New_York")
                          )}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <Link href={link}>
                          {historical_submission.grader_results?.score !== undefined &&
                          historical_submission.grader_results?.errors === null
                            ? historical_submission.grader_results?.score +
                              "/" +
                              historical_submission.grader_results?.max_score
                            : "Error"}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <Link href={link}>
                          {historical_submission.submission_reviews?.completed_at &&
                            historical_submission.submission_reviews?.total_score +
                              "/" +
                              historical_submission.assignments.total_points}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        {historical_submission.is_active ? (
                          <>This submission is active</>
                        ) : (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={async () => {
                              await activateSubmission({ submission_id: historical_submission.id }, supabase);
                              invalidate({ resource: "submissions", invalidates: ["list"] });
                              router.push(link);
                            }}
                          >
                            <Icon as={FaCheckCircle} />
                            Activate
                          </Button>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Box>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}

function TestResults() {
  const submission = useSubmission();
  const pathname = usePathname();
  const testResults = submission.grader_results?.grader_result_tests;
  const totalScore = testResults?.reduce((acc, test) => acc + (test.score || 0), 0);
  const totalMaxScore = testResults?.reduce((acc, test) => acc + (test.max_score || 0), 0);
  return (
    <Box>
      <Heading size="md" mt={2}>
        Automated Check Results ({totalScore}/{totalMaxScore})
      </Heading>
      {testResults?.map((test) => {
        let icon;
        const extraData = test.extra_data as GraderResultTestData;
        if (extraData?.icon && iconMap[extraData.icon]) {
          icon = <Icon as={iconMap[extraData.icon]} />;
        } else if (test.score === 0 && test.max_score === 0) {
          icon = <Icon as={FaInfo} color="fg.info" />;
        } else if (test.score == test.max_score) {
          icon = <Icon as={FaCheckCircle} color="fg.success" />;
        } else {
          icon = <Icon as={FaTimesCircle} color="fg.error" />;
        }
        const showScore = extraData?.hide_score !== "true" && test.max_score !== 0;
        return (
          <Box key={test.id} border="1px solid" borderColor="border.emphasized" borderRadius="md" p={2} mt={2} w="100%">
            {icon}
            <Link href={linkToSubPage(pathname, "results") + `#test-${test.id}`}>
              <Heading size="sm">
                {test.name} {showScore ? test.score + "/" + test.max_score : ""}
              </Heading>
            </Link>
          </Box>
        );
      })}
    </Box>
  );
}
function ReviewStats() {
  const submission = useSubmission();
  const review = useSubmissionReviewOrGradingReview();
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
  const mostRecentGrader = allRubricInstances.find(
    (instance) => Date.parse(instance.created_at) === mostRecentCreationOrEdit
  )?.author;
  if (!review) {
    return <Skeleton height="20px" />;
  }
  return (
    <DataListRoot orientation="horizontal">
      <DataListItem label="Released to student" value={review.released ? "Yes" : "No"} />
      {completed_by && <DataListItem label="Completed by" value={<PersonName size="2xs" uid={completed_by} />} />}
      {completed_at && <DataListItem label="Completed at" value={formatRelative(completed_at, new Date())} />}
      {checked_by && <DataListItem label="Checked by" value={<PersonName size="2xs" uid={checked_by} />} />}
      {checked_at && <DataListItem label="Checked at" value={formatRelative(checked_at, new Date())} />}
      {mostRecentGrader && (
        <DataListItem label="Last updated by" value={<PersonName size="2xs" uid={mostRecentGrader} />} />
      )}
      {allGraders.size > 0 && (
        <DataListItem
          label="Other graders"
          value={Array.from(allGraders).map((grader) => (
            <PersonName size="2xs" key={grader} uid={grader} />
          ))}
        />
      )}
    </DataListRoot>
  );
}

function ReviewActions() {
  const review = useSubmissionReviewOrGradingReview();
  const { private_profile_id } = useClassProfiles();
  const { mutateAsync: updateReview } = useUpdate<SubmissionReviewWithRubric>({
    resource: "submission_reviews"
  });
  if (!review) {
    return <Skeleton height="20px" />;
  }
  return (
    <VStack>
      <Toaster />
      <ReviewStats />
      <HStack>
        {!review.completed_at && <CompleteReviewButton />}
        {review.completed_at && !review.checked_at && private_profile_id !== review.completed_by && (
          <Button
            variant="surface"
            onClick={() => {
              updateReview({ id: review.id, values: { checked_at: new Date(), checked_by: private_profile_id } });
            }}
          >
            Mark as Checked
          </Button>
        )}
        {review.released ? (
          <Button
            variant="surface"
            onClick={() => {
              updateReview({ id: review.id, values: { released: false } });
            }}
          >
            Unrelease
          </Button>
        ) : (
          <Button
            variant="surface"
            onClick={() => {
              updateReview({ id: review.id, values: { released: true } });
            }}
          >
            Release To Student
          </Button>
        )}
      </HStack>
    </VStack>
  );
}
function UnGradedGradingSummary() {
  const submission = useSubmission();
  const graderResultsMaxScore = submission.grader_results?.max_score;
  const totalMaxScore = submission.assignments.total_points;

  return (
    <Box>
      <Heading size="xl">Grading Summary</Heading>
      <Text color="text.muted" fontSize="sm">
        This assignment is worth a total of {totalMaxScore} points, broken down as follows:
      </Text>
      <List.Root as="ul" fontSize="sm" color="text.muted">
        {submission.assignments.autograder_points !== null && submission.assignments.total_points !== null && (
          <List.Item>
            <Text as="span" fontWeight="bold">
              Hand Grading:
            </Text>{" "}
            {submission.assignments.total_points - submission.assignments.autograder_points} points. This has not been
            graded yet.
          </List.Item>
        )}
        <List.Item>
          <Text as="span" fontWeight="bold">
            Automated Checks:
          </Text>{" "}
          {graderResultsMaxScore} points, results shown below.
        </List.Item>
        {graderResultsMaxScore !== undefined && totalMaxScore !== null && graderResultsMaxScore > totalMaxScore && (
          <List.Item>
            <Text as="span" fontWeight="bold">
              Hidden Automated Checks:
            </Text>{" "}
            {graderResultsMaxScore - totalMaxScore} points will be awarded by automated tests that are not shown until
            after grading is complete.
          </List.Item>
        )}
      </List.Root>
    </Box>
  );
}

function RubricView() {
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const activeReviewAssignmentId = useActiveReviewAssignmentId();
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const course = useCourse();

  const {
    reviewAssignment,
    isLoading: isLoadingReviewAssignment,
    error: reviewAssignmentError
  } = useReviewAssignment(activeReviewAssignmentId);

  const gradingReview = useSubmissionReviewOrGradingReview();

  return (
    <Box
      position="sticky"
      top="0"
      borderTopWidth={{ base: "1px", lg: "0" }}
      borderLeftWidth={{ base: "0", lg: "1px" }}
      borderColor="border.emphasized"
      padding="2"
      height="100vh"
      overflowX="hidden"
      overflowY="auto"
      ref={scrollRootRef}
    >
      <VStack align="start" gap={2}>
        {isLoadingReviewAssignment && activeReviewAssignmentId && <Skeleton height="100px" />}
        {reviewAssignmentError && activeReviewAssignmentId && (
          <Text color="red.500">Error loading review details: {reviewAssignmentError.message}</Text>
        )}
        {activeReviewAssignmentId && reviewAssignment && !isLoadingReviewAssignment && !reviewAssignmentError && (
          <Box mb={2} p={2} borderWidth="1px" borderRadius="md" borderColor="border.default">
            <Heading size="md">
              Review Task: {reviewAssignment.rubrics?.name} ({reviewAssignment.rubrics?.review_round})
            </Heading>
            <Text fontSize="sm">Assigned to: {reviewAssignment.profiles?.name || "N/A"}</Text>
            <Text fontSize="sm">
              Due:{" "}
              {reviewAssignment.due_date
                ? formatDueDateInTimezone(
                    reviewAssignment.due_date,
                    course.time_zone ?? "America/New_York",
                    false,
                    false
                  )
                : "N/A"}
            </Text>
            {reviewAssignment.release_date && (
              <Text fontSize="sm">
                Grading visible to student after:{" "}
                {formatDueDateInTimezone(
                  reviewAssignment.release_date,
                  course.time_zone ?? "America/New_York",
                  false,
                  false
                )}
              </Text>
            )}
          </Box>
        )}
        {submission.assignments.total_points !== null && (
          <Heading size="xl">
            Overall Score ({gradingReview?.total_score}/{submission.assignments.total_points})
          </Heading>
        )}
        {!activeReviewAssignmentId && !gradingReview && <UnGradedGradingSummary />}
        {isGraderOrInstructor && <ReviewActions />}
        <TestResults />
        <ListOfRubricsInSidebar scrollRootRef={scrollRootRef} />
        <Comments />
      </VStack>
    </Box>
  );
}

function Comments() {
  const comments = useSubmissionComments({}).filter((comment) => !comment.rubric_check_id);
  if (!comments || comments.length === 0) {
    return null;
  }
  return (
    <Box>
      <Heading size="md">Comments</Heading>
      <VStack align="start" gap={2}>
        {comments.map((comment) => (
          <RubricCheckComment key={comment.id} comment={comment} />
        ))}
      </VStack>
    </Box>
  );
}

function SubmissionsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const submission = useSubmission();
  const submitter = useUserProfile(submission.profile_id);
  return (
    <Flex direction="column" minW="0px">
      <Flex px={4} py={2} gap="2" alignItems="center" justify="space-between" align="center" wrap="wrap">
        <Box>
          <VStack align="flex-start">
            <HStack gap={1}>
              {submission.is_active && <ActiveSubmissionIcon />}
              {submission.assignment_groups ? (
                <Text>
                  Group {submission.assignment_groups.name} (
                  {submission.assignment_groups.assignment_groups_members
                    .map((member) => member.profiles!.name)
                    .join(", ")}
                  )
                </Text>
              ) : (
                <Text>{submitter?.name}</Text>
              )}
              - Submission #{submission.ordinal}
            </HStack>
            <HStack gap={1}>
              <Link href={`https://github.com/${submission.repository}/commit/${submission.sha}`} target="_blank">
                Commit {submission.sha.substring(0, 7)}
              </Link>
              <Link href={`https://github.com/${submission.repository}/archive/${submission.sha}.zip`} target="_blank">
                (Download)
              </Link>
            </HStack>
          </VStack>
        </Box>
        {!submission.is_active && (
          <Box rounded="sm" bg="red.fg" color="fg.inverted" px={6} py={2} textAlign="center" m={0}>
            <Heading size="md">Viewing a previous submission.</Heading>
            <Text fontSize="xs">
              Use the submission history to view or change the active submission. The active submission is the one that
              will be graded.
            </Text>
          </Box>
        )}
        <HStack>
          <AskForHelpButton />
          <SubmissionHistory submission={submission} />
        </HStack>
      </Flex>
      <SubmissionReviewToolbar />
      <Box
        p={0}
        m={0}
        borderBottomColor="border.emphasized"
        borderBottomWidth="2px"
        bg="bg.muted"
        defaultValue="results"
      >
        <NextLink prefetch={true} href={linkToSubPage(pathname, "results", searchParams)}>
          <Button variant={pathname.includes("/results") ? "solid" : "ghost"}>
            <Icon as={FaCheckCircle} />
            Grading Summary
          </Button>
        </NextLink>
        <NextLink prefetch={true} href={linkToSubPage(pathname, "files", searchParams)}>
          <Button variant={pathname.includes("/files") ? "solid" : "ghost"}>
            <Icon as={FaFile} />
            Files
          </Button>
        </NextLink>
      </Box>
      <Flex flexDirection={"row"} wrap="wrap">
        <Box flex={10} pr={4}>
          {children}
        </Box>
        <Box flex={1} minWidth={{ base: "100%", lg: "md" }}>
          <RubricView />
        </Box>
      </Flex>
    </Flex>
  );
}

export default function SubmissionsLayoutWrapper({ children }: { children: React.ReactNode }) {
  const { submissions_id } = useParams();
  return (
    <SubmissionProvider submission_id={Number(submissions_id)}>
      <SubmissionsLayout>{children}</SubmissionsLayout>
    </SubmissionProvider>
  );
}
