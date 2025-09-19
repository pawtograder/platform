"use client";
import { Button } from "@/components/ui/button";
import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import {
  Submission,
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
import { toaster, Toaster } from "@/components/ui/toaster";
import { useClassProfiles, useIsGraderOrInstructor, useIsInstructor } from "@/hooks/useClassProfiles";
import { useAssignmentDueDate, useCourse } from "@/hooks/useCourseController";
import {
  SubmissionProvider,
  useReviewAssignment,
  useRubricCriteriaInstances,
  useSubmission,
  useSubmissionComments,
  useSubmissionController,
  useSubmissionReviewOrGradingReview
} from "@/hooks/useSubmission";
import { useActiveReviewAssignmentId } from "@/hooks/useSubmissionReview";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { activateSubmission } from "@/lib/edgeFunctions";
import { formatDueDateInTimezone } from "@/lib/utils";
import { createClient } from "@/utils/supabase/client";
import { Icon } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { CrudFilter, useInvalidate, useList } from "@refinedev/core";
import { formatRelative } from "date-fns";
import NextLink from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { ElementType as ReactElementType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BsFileEarmarkCodeFill, BsThreeDots } from "react-icons/bs";
import {
  FaBell,
  FaCheckCircle,
  FaFile,
  FaHistory,
  FaInfo,
  FaQuestionCircle,
  FaRobot,
  FaTimesCircle
} from "react-icons/fa";
import { FiDownloadCloud, FiRepeat, FiSend } from "react-icons/fi";
import { HiOutlineInformationCircle } from "react-icons/hi";
import { LuMoon, LuSun } from "react-icons/lu";
import { PiSignOut } from "react-icons/pi";
import { RxQuestionMarkCircled } from "react-icons/rx";
import { TbMathFunction } from "react-icons/tb";
import { GraderResultTestExtraData } from "@/utils/supabase/DatabaseTypes";
import { linkToSubPage } from "./utils";
import { useAssignmentController } from "@/hooks/useAssignment";
import * as Sentry from "@sentry/nextjs";

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
function SubmissionReviewScoreTweak() {
  const submission = useSubmission();
  const reviewId = submission.grading_review_id;
  if (!reviewId) {
    throw new Error("No grading review ID found");
  }
  const review = useSubmissionReviewOrGradingReview(reviewId);
  const isInstructor = useIsInstructor();
  const [tweakValue, setTweakValue] = useState<number | undefined>(review?.tweak);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionController = useSubmissionController();

  const handleTweakChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "") {
      setTweakValue(undefined);
    } else {
      const num = Number(val);
      if (!isNaN(num)) {
        setTweakValue(num);
      }
    }
  }, []);

  const handleTweakSave = useCallback(async () => {
    if (!review) {
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      // Normalize undefined → null and skip if no change
      const original = review.tweak ?? null;
      const current = tweakValue ?? null;
      if (original === current) {
        setIsEditing(false);
        return;
      }
      await submissionController.submission_reviews.update(review.id, {
        tweak: current ?? 0
      });
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save tweak");
    } finally {
      setIsSaving(false);
    }
  }, [review, tweakValue, submissionController]);

  const handleCancel = useCallback(() => {
    setTweakValue(review?.tweak);
    setIsEditing(false);
    setError(null);
  }, [review?.tweak]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleTweakSave();
      } else if (e.key === "Escape") {
        handleCancel();
      }
    },
    [handleTweakSave, handleCancel]
  );

  if (!review) {
    return <></>;
  }

  if (!isInstructor) {
    if (review.tweak) {
      return <Text>Includes instructor&apos;s tweak {review.tweak}</Text>;
    }
    return <></>;
  }

  if (isEditing) {
    return (
      <Box mt={2} mb={2}>
        <HStack align="center" gap={2}>
          <Text fontWeight="bold" fontSize="sm">
            Tweak:
          </Text>
          <input
            type="number"
            step="any"
            value={tweakValue ?? ""}
            onChange={handleTweakChange}
            onKeyDown={handleKeyDown}
            autoFocus
            style={{
              width: "80px",
              padding: "4px 8px",
              border: "1px solid #ccc",
              borderRadius: "4px",
              fontSize: "14px"
            }}
            aria-label="Tweak score"
          />
          <Button size="sm" variant="surface" onClick={handleTweakSave} loading={isSaving} disabled={isSaving}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={handleCancel} disabled={isSaving}>
            Cancel
          </Button>
        </HStack>
        {error && (
          <Text color="red.500" fontSize="sm" mt={1}>
            {error}
          </Text>
        )}
      </Box>
    );
  }

  // Display mode - show current tweak or placeholder
  return (
    <Box mt={2} mb={2}>
      <HStack align="center" gap={2}>
        <Text fontWeight="bold" fontSize="sm">
          Tweak:
        </Text>
        {review.tweak !== null && review.tweak !== undefined ? (
          <Text
            as="span"
            cursor="pointer"
            color="blue.500"
            textDecoration="underline"
            _hover={{ color: "blue.600" }}
            onClick={() => setIsEditing(true)}
            aria-label="Click to edit tweak"
          >
            {review.tweak}
          </Text>
        ) : (
          <Text
            as="span"
            cursor="pointer"
            color="gray.500"
            fontStyle="italic"
            _hover={{ color: "gray.600" }}
            onClick={() => setIsEditing(true)}
            aria-label="Click to add tweak"
          >
            Click to add tweak
          </Text>
        )}
      </HStack>
    </Box>
  );
}
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
    ],
    pagination: {
      pageSize: 1000
    }
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
  const [isActivating, setIsActivating] = useState(false);
  const isGraderInterface = pathname.includes("/grade");
  const { dueDate } = useAssignmentDueDate(submission.assignments, {
    studentPrivateProfileId: submission.profile_id || undefined
  });
  const isStaff = useIsGraderOrInstructor();
  const disableActivationButton = Boolean(
    dueDate &&
      TZDate.tz(time_zone ?? "America/New_York").getTime() >
        new TZDate(dueDate, time_zone ?? "America/New_York").getTime() &&
      !isStaff
  );
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
            <Toaster />
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
                          {!historical_submission.grader_results
                            ? "In Progress"
                            : historical_submission.grader_results && historical_submission.grader_results.errors
                              ? "Error"
                              : `${historical_submission.grader_results?.score}/${historical_submission.grader_results?.max_score}`}
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
                        ) : historical_submission.is_not_graded ? (
                          <>Not for grading</>
                        ) : (
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={disableActivationButton}
                            loading={isActivating}
                            onClick={async () => {
                              setIsActivating(true);
                              try {
                                const supabase = createClient();
                                await activateSubmission({ submission_id: historical_submission.id }, supabase);
                                invalidate({ resource: "submissions", invalidates: ["list"] });
                                toaster.create({
                                  title: "Active submission changed",
                                  type: "success"
                                });
                                router.push(link);
                              } catch (error) {
                                const errorId = Sentry.captureException(error);
                                toaster.create({
                                  title: "Error activating submission",
                                  description: `We have recorded this error with trace ID: ${errorId}`,
                                  type: "error"
                                });
                              } finally {
                                setIsActivating(false);
                              }
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
        const extraData = test.extra_data as GraderResultTestExtraData;
        if (extraData?.llm?.prompt || extraData?.llm?.result) {
          icon = <Icon as={FaRobot} />;
        } else if (extraData?.icon && iconMap[extraData.icon]) {
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
  const reviewId = submission.grading_review_id;
  if (!reviewId) {
    throw new Error("No grading review ID found");
  }
  const review = useSubmissionReviewOrGradingReview(reviewId);
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
  const submission = useSubmission();
  const reviewId = submission.grading_review_id;
  if (!reviewId) {
    throw new Error("No grading review ID found");
  }
  const review = useSubmissionReviewOrGradingReview(reviewId);
  const { private_profile_id } = useClassProfiles();
  const submissionController = useSubmissionController();
  const [updatingReview, setUpdatingReview] = useState(false);
  const isInstructor = useIsGraderOrInstructor();
  if (!review) {
    return <Skeleton height="20px" />;
  }
  return (
    <VStack>
      <Toaster />
      <ReviewStats />
      {isInstructor && (!review.completed_at || (review.completed_at && !review.checked_at)) && (
        <VStack>
          <Heading size="md">Submission Review Actions</Heading>
          <HStack w="100%" justify="space-between">
            {!review.completed_at && <CompleteReviewButton />}
            {review.completed_at && !review.checked_at && private_profile_id !== review.completed_by && (
              <Button
                variant="surface"
                loading={updatingReview}
                onClick={async () => {
                  try {
                    setUpdatingReview(true);
                    await submissionController.submission_reviews.update(review.id, {
                      checked_at: new Date().toISOString(),
                      checked_by: private_profile_id
                    });
                  } finally {
                    setUpdatingReview(false);
                  }
                }}
              >
                Mark as Checked
              </Button>
            )}
          </HStack>
        </VStack>
      )}
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
  const rubricPartsAdvice = useMemo(() => {
    return reviewAssignment?.review_assignment_rubric_parts
      ?.map((part) => reviewAssignment?.rubrics?.rubric_parts?.find((p) => p.id === part.rubric_part_id)?.name)
      .join(", ");
  }, [reviewAssignment?.review_assignment_rubric_parts, reviewAssignment?.rubrics?.rubric_parts]);

  const reviewId = submission.grading_review_id;
  if (!reviewId) {
    throw new Error("No grading review ID found");
  }
  const gradingReview = useSubmissionReviewOrGradingReview(reviewId);

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
            {rubricPartsAdvice && <Text fontSize="sm">Only grading rubric part(s): {rubricPartsAdvice}</Text>}
            <Text fontSize="sm">Assigned to: {reviewAssignment.profiles?.name || "N/A"}</Text>
            <Text fontSize="sm" data-visual-test="blackout">
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
        {submission.assignments.total_points !== null &&
          gradingReview &&
          gradingReview.total_score !== null &&
          gradingReview.total_score !== undefined && (
            <Heading size="xl">
              Overall Score ({gradingReview.total_score}/{submission.assignments.total_points})
            </Heading>
          )}
        <SubmissionReviewScoreTweak />
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
          <RubricCheckComment key={comment.id} comment_id={comment.id} comment_type="submission" />
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
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const assignment = useAssignmentController();
  useEffect(() => {
    if (isGraderOrInstructor) {
      document.title = `${assignment?.assignment?.title} - ${submitter?.name} - Pawtograder`;
    } else if (!isGraderOrInstructor) {
      document.title = `${assignment?.assignment?.title} - Submission #${submission.ordinal} - Pawtograder`;
    }
  }, [assignment, isGraderOrInstructor, submitter, submission]);
  return (
    <Flex direction="column" minW="0px">
      <SubmissionReviewToolbar />
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
        {submission.is_not_graded && (
          <Box flexShrink={1} maxW="lg" rounded="sm" bg="fg.warning" color="fg.inverted" p={2} textAlign="center" m={0}>
            <Heading size="md">Viewing a not-for-grading submission.</Heading>
            <Text fontSize="xs">
              This submission was created with #NOT-GRADED in the commit message and cannot ever become active. It will
              not be graded. You can still see autograder feedback.
            </Text>
          </Box>
        )}
        {!submission.is_active && !submission.is_not_graded && (
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

      <Box
        p={0}
        m={0}
        borderBottomColor="border.emphasized"
        borderBottomWidth="2px"
        bg="bg.muted"
        defaultValue="results"
      >
        <NextLink href={linkToSubPage(pathname, "results", searchParams)}>
          <Button variant={pathname.includes("/results") ? "solid" : "ghost"}>
            <Icon as={FaCheckCircle} />
            Grading Summary
          </Button>
        </NextLink>
        <NextLink href={linkToSubPage(pathname, "files", searchParams)}>
          <Button variant={pathname.includes("/files") ? "solid" : "ghost"}>
            <Icon as={FaFile} />
            Files
          </Button>
        </NextLink>
      </Box>
      <Flex flexDirection={"row"} wrap="wrap">
        <Box flex={{ base: "1 1 100%", lg: "1 1 0" }} minWidth={0} pr={4}>
          {children}
        </Box>
        <Box flex={{ base: "0 0 100%", lg: "0 0 28rem" }}>
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
