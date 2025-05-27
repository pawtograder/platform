"use client";
import { Button } from "@/components/ui/button";
import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import type {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart,
  Submission,
  SubmissionReviewWithRubric,
  SubmissionWithFilesGraderResultsOutputTestsAndRubric,
  SubmissionWithGraderResultsAndReview
} from "@/utils/supabase/DatabaseTypes";
import { Box, Flex, Heading, HStack, List, Popover, Skeleton, Table, Text, VStack } from "@chakra-ui/react";

import { ActiveSubmissionIcon } from "@/components/ui/active-submission-icon";
import AskForHelpButton from "@/components/ui/ask-for-help-button";
import { DataListItem, DataListRoot } from "@/components/ui/data-list";
import Link from "@/components/ui/link";
import PersonName from "@/components/ui/person-name";
import RubricSidebar, { RubricCheckComment } from "@/components/ui/rubric-sidebar";
import { Toaster, toaster } from "@/components/ui/toaster";
import { useClassProfiles, useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useCourse } from "@/hooks/useCourseController";
import useModalManager from "@/hooks/useModalManager";
import {
  SubmissionProvider,
  useAllRubricCheckInstances,
  useReviewAssignment,
  useRubricCriteriaInstances,
  useSubmission,
  useSubmissionComments,
  useSubmissionReview,
  useSubmissionReviewByAssignmentId,
  useSubmissionRubric
} from "@/hooks/useSubmission";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { activateSubmission } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import type { Tables } from "@/utils/supabase/SupabaseTypes";
import { Icon } from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { type CrudFilter, useInvalidate, useList, useShow, useUpdate } from "@refinedev/core";
import { Select as ChakraReactSelect, type OptionBase } from "chakra-react-select";
import { format, formatRelative } from "date-fns";
import NextLink from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ElementType as ReactElementType, useEffect, useMemo, useState } from "react";
import { BsFileEarmarkCodeFill, BsThreeDots } from "react-icons/bs";
import {
  FaBell,
  FaCheckCircle,
  FaFile,
  FaHistory,
  FaInfo,
  FaLink,
  FaQuestionCircle,
  FaRegCheckCircle,
  FaTimesCircle
} from "react-icons/fa";
import { FiDownloadCloud, FiRepeat, FiSend } from "react-icons/fi";
import { HiOutlineInformationCircle } from "react-icons/hi";
import { LuMoon, LuSun } from "react-icons/lu";
import { PiSignOut } from "react-icons/pi";
import { RxQuestionMarkCircled } from "react-icons/rx";
import { TbMathFunction } from "react-icons/tb";
import AddRubricReferenceModal from "./addRubricReferenceModal";
import type { GraderResultTestData } from "./results/page";
import { linkToSubPage } from "./utils";

interface RubricOptionType extends OptionBase {
  value: number;
  label: string;
}

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
      <PopoverContent width="lg">
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
                          {historical_submission.grader_results?.score !== undefined
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

function incompleteRubricChecks(
  rubric: Tables<"rubrics"> & { rubric_parts: Array<HydratedRubricPart> },
  comments: { rubric_check_id: number | null; submission_review_id: number | null }[]
): {
  required_checks: HydratedRubricCheck[];
  optional_checks: HydratedRubricCheck[];
  required_criteria: {
    criteria: HydratedRubricCriteria;
    check_count_applied: number;
  }[];
  optional_criteria: {
    criteria: HydratedRubricCriteria;
    check_count_applied: number;
  }[];
} {
  const allRubricCriteria = rubric.rubric_parts.flatMap((part) => part.rubric_criteria || []);

  const required_checks = allRubricCriteria.flatMap((criteria) =>
    criteria.rubric_checks.filter(
      (check) => check.is_required && !comments.some((comment) => comment.rubric_check_id === check.id)
    )
  ) as HydratedRubricCheck[];
  const optional_checks = allRubricCriteria
    .filter((criteria) => criteria.min_checks_per_submission === null)
    .flatMap((criteria) =>
      criteria.rubric_checks.filter(
        (check) => !check.is_required && !comments.some((comment) => comment.rubric_check_id === check.id)
      )
    ) as HydratedRubricCheck[];
  const criteriaEvaluation = allRubricCriteria.map((criteria) => ({
    criteria: criteria as HydratedRubricCriteria,
    check_count_applied: criteria.rubric_checks.filter((check) =>
      comments.some((comment) => comment.rubric_check_id === check.id)
    ).length
  }));
  const required_criteria = criteriaEvaluation.filter(
    (item) =>
      item.criteria.min_checks_per_submission !== null &&
      item.check_count_applied < item.criteria.min_checks_per_submission
  );
  const optional_criteria = criteriaEvaluation.filter(
    (item) => item.criteria.min_checks_per_submission === null && item.check_count_applied === 0
  );
  return {
    required_checks,
    optional_checks,
    required_criteria,
    optional_criteria
  };
}
function CompleteRubricButton() {
  const review = useSubmissionReview();
  const { rubric: actualRubric, isLoading: isLoadingRubric } = useSubmissionRubric();
  const comments = useAllRubricCheckInstances(review?.id);
  const { mutateAsync: updateReview } = useUpdate<SubmissionReviewWithRubric>({
    resource: "submission_reviews"
  });
  const { private_profile_id } = useClassProfiles();

  if (isLoadingRubric || !actualRubric) {
    // Render a loading state or disabled button
    return (
      <Button variant="surface" loading>
        Graded <Icon as={FaRegCheckCircle} />
      </Button>
    );
  }

  const { required_checks, optional_checks, required_criteria, optional_criteria } = incompleteRubricChecks(
    actualRubric,
    comments
  );
  const missingRequiredChecks = required_checks.length > 0 || required_criteria.length > 0;
  const missingOptionalChecks = optional_checks.length > 0 || optional_criteria.length > 0;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="surface">
          Graded <Icon as={FaRegCheckCircle} />
        </Button>
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content>
          <Popover.Arrow>
            <Popover.ArrowTip />
          </Popover.Arrow>
          <Popover.Body
            bg={missingRequiredChecks ? "bg.error" : missingOptionalChecks ? "bg.warning" : "bg.success"}
            borderRadius="md"
          >
            <VStack align="start">
              <Box w="100%">
                <Heading size="md">
                  {missingRequiredChecks
                    ? "Required Checks Missing"
                    : missingOptionalChecks
                      ? "Confirm that you have carefully reviewed the submission"
                      : "Complete Grading"}
                </Heading>
              </Box>
              {missingRequiredChecks && (
                <Box>
                  <Heading size="sm">
                    These checks are required. Please grade them before marking the submission as graded.
                  </Heading>
                  <List.Root as="ol">
                    {required_checks.map((check) => (
                      <List.Item key={check.id}>{check.name}</List.Item>
                    ))}
                    {required_criteria.map((criteria) => (
                      <List.Item key={criteria.criteria.id}>
                        {criteria.criteria.name} (select at least {criteria.criteria.min_checks_per_submission} checks)
                      </List.Item>
                    ))}
                  </List.Root>
                </Box>
              )}
              {missingOptionalChecks && (
                <Box>
                  <Heading size="sm">
                    These checks were not applied, but not required. Please take a quick look to make sure that you did
                    not miss anything:
                  </Heading>
                  <List.Root as="ol">
                    {optional_checks.map((check) => (
                      <List.Item key={check.id}>{check.name}</List.Item>
                    ))}
                    {optional_criteria.map((criteria) => (
                      <List.Item key={criteria.criteria.id}>
                        {criteria.criteria.name} (select at least {criteria.criteria.min_checks_per_submission} checks)
                      </List.Item>
                    ))}
                  </List.Root>
                </Box>
              )}
              {!missingRequiredChecks && !missingOptionalChecks && (
                <Text>All checks have been graded. Click the button below to mark the submission as graded.</Text>
              )}
              {!missingRequiredChecks && (
                <Button
                  variant="solid"
                  colorPalette="green"
                  onClick={() => {
                    updateReview({
                      id: review!.id,
                      values: { completed_at: new Date(), completed_by: private_profile_id }
                    });
                  }}
                >
                  Mark as Graded
                </Button>
              )}
            </VStack>
          </Popover.Body>
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  );
}
function ReviewActions() {
  const review = useSubmissionReview();
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
        {!review.completed_at && <CompleteRubricButton />}
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
  const searchParams = useSearchParams();
  const reviewAssignmentIdParam = searchParams.get("review_assignment_id");
  const reviewAssignmentId = reviewAssignmentIdParam ? parseInt(reviewAssignmentIdParam, 10) : undefined;
  const [selectedRubricIdState, setSelectedRubricIdState] = useState<number | undefined>(undefined);

  const {
    isOpen: isAddReferenceModalOpen,
    openModal: openAddReferenceModal,
    closeModal: closeAddReferenceModal,
    modalData: addReferenceModalData
  } = useModalManager<{ currentRubricId: number }>();

  const {
    reviewAssignment,
    isLoading: isLoadingReviewAssignment,
    error: reviewAssignmentError
  } = useReviewAssignment(reviewAssignmentId);

  const assignmentId = submission.assignments.id;

  const { data: assignmentRubricsData, isLoading: isLoadingAssignmentRubrics } = useList<Tables<"rubrics">>({
    resource: "rubrics",
    filters: [{ field: "assignment_id", operator: "eq", value: assignmentId }],
    queryOptions: {
      enabled: !!assignmentId
    },
    meta: {
      select: "id, name, review_round"
    }
  });

  useEffect(() => {
    if (reviewAssignmentId && reviewAssignment?.rubric_id) {
      setSelectedRubricIdState(reviewAssignment.rubric_id);
    } else if (submission.assignments.grading_rubric_id) {
      setSelectedRubricIdState(submission.assignments.grading_rubric_id);
    } else if (assignmentRubricsData?.data && assignmentRubricsData.data.length > 0) {
      setSelectedRubricIdState(assignmentRubricsData.data[0]?.id);
    }
  }, [
    reviewAssignmentId,
    reviewAssignment?.rubric_id,
    submission.assignments.grading_rubric_id,
    assignmentRubricsData?.data
  ]);

  const rubricIdToDisplay =
    reviewAssignmentId && reviewAssignment?.rubric_id ? reviewAssignment.rubric_id : selectedRubricIdState;

  const { query: rubricToDisplayQuery } = useShow<HydratedRubric>({
    resource: "rubrics",
    id: rubricIdToDisplay,
    queryOptions: {
      enabled: !!rubricIdToDisplay
    },
    meta: {
      select: "*, rubric_parts(*, rubric_criteria(*, rubric_checks(*)))"
    }
  });
  const rubricToDisplayData = rubricToDisplayQuery?.data?.data;
  const isLoadingRubricToDisplay = rubricToDisplayQuery?.isLoading;

  const assignmentRubricData = rubricToDisplayData;
  let preparedInitialRubric: HydratedRubric | undefined = undefined;

  if (assignmentRubricData) {
    // useShow with the correct select should directly return HydratedRubric
    preparedInitialRubric = assignmentRubricData;
  }

  const mainSubmissionReviewData = useSubmissionReview();
  const { submissionReview: peerReviewSubmissionData } = useSubmissionReviewByAssignmentId(reviewAssignmentId);

  const activeReviewForSidebar = reviewAssignmentId ? peerReviewSubmissionData : mainSubmissionReviewData;

  const rubricOptions: RubricOptionType[] = useMemo(() => {
    return (
      assignmentRubricsData?.data.map((rubric) => ({
        value: rubric.id,
        label: `${rubric.name} (${rubric.review_round || "N/A"})`
      })) || []
    );
  }, [assignmentRubricsData]);

  const displayScoreFromReview = activeReviewForSidebar;

  const showHandGradingControls =
    isGraderOrInstructor || (activeReviewForSidebar?.released ?? false) || !!reviewAssignmentId;

  const handleOpenAddReferenceModal = () => {
    if (!rubricToDisplayData) {
      toaster.error({ title: "Error", description: "Rubric data is not loaded yet." });
      return;
    }
    if (!rubricIdToDisplay) {
      toaster.error({ title: "Error", description: "Current rubric ID is not available." });
      return;
    }
    openAddReferenceModal({ currentRubricId: rubricIdToDisplay });
  };

  return (
    <Box
      position="sticky"
      top="0"
      borderLeftWidth="1px"
      borderColor="border.emphasized"
      p={2}
      ml={0}
      minW="md"
      maxW="lg"
      height="100vh"
      overflowY="auto"
    >
      <VStack align="start" gap={2}>
        {isLoadingReviewAssignment && reviewAssignmentId && <Skeleton height="100px" />}
        {reviewAssignmentError && reviewAssignmentId && (
          <Text color="red.500">Error loading review details: {reviewAssignmentError.message}</Text>
        )}
        {reviewAssignmentId && reviewAssignment && !isLoadingReviewAssignment && !reviewAssignmentError && (
          <Box mb={2} p={2} borderWidth="1px" borderRadius="md" borderColor="border.default">
            <Heading size="md">
              Review Task: {reviewAssignment.rubrics?.name} ({reviewAssignment.rubrics?.review_round})
            </Heading>
            <Text fontSize="sm">Assigned to: {reviewAssignment.profiles?.name || "N/A"}</Text>
            <Text fontSize="sm">
              Due: {reviewAssignment.due_date ? format(new Date(reviewAssignment.due_date), "Pp") : "N/A"}
            </Text>
            {reviewAssignment.release_date && (
              <Text fontSize="sm">
                Grading visible to student after: {format(new Date(reviewAssignment.release_date), "Pp")}
              </Text>
            )}
          </Box>
        )}
        {!reviewAssignmentId && !isLoadingAssignmentRubrics && rubricOptions.length > 1 && (
          <Box w="full">
            <Text fontSize="sm" fontWeight="bold" mb={1}>
              Select Rubric to View:
            </Text>
            <ChakraReactSelect<RubricOptionType, false>
              options={rubricOptions}
              value={rubricOptions.find((option) => option.value === selectedRubricIdState)}
              onChange={(option) => setSelectedRubricIdState(option?.value)}
              isLoading={isLoadingAssignmentRubrics || isLoadingRubricToDisplay}
              isDisabled={!!reviewAssignmentId}
              chakraStyles={{ menu: (provided) => ({ ...provided, zIndex: 9999 }) }}
            />
          </Box>
        )}
        {displayScoreFromReview && submission.assignments.total_points !== null && (
          <Heading size="xl">
            Overall Score ({displayScoreFromReview.total_score}/{submission.assignments.total_points})
          </Heading>
        )}
        {!reviewAssignmentId && !activeReviewForSidebar && <UnGradedGradingSummary />}
        {isGraderOrInstructor && <ReviewActions />}
        <TestResults />
        {isGraderOrInstructor && rubricIdToDisplay && !reviewAssignmentId && rubricToDisplayData && (
          <Button onClick={handleOpenAddReferenceModal} variant="outline" size="sm" mt={2}>
            <HStack>
              <Icon as={FaLink} />
              <Text>Reference Check from Another Rubric</Text>
            </HStack>
          </Button>
        )}
        {addReferenceModalData &&
          rubricToDisplayData &&
          rubricToDisplayData.rubric_parts &&
          submission.assignments.id &&
          submission.class_id && (
            <AddRubricReferenceModal
              isOpen={isAddReferenceModalOpen}
              onClose={closeAddReferenceModal}
              currentRubricChecks={rubricToDisplayData.rubric_parts.flatMap((p) =>
                p.rubric_criteria.flatMap((c) => c.rubric_checks)
              )}
              currentRubricId={addReferenceModalData.currentRubricId}
              assignmentId={submission.assignments.id}
              classId={submission.class_id}
            />
          )}
        {showHandGradingControls && (
          <RubricSidebar
            initialRubric={preparedInitialRubric}
            reviewAssignmentId={reviewAssignmentId}
            submissionReview={activeReviewForSidebar}
          />
        )}
        {!showHandGradingControls && <Text>Rubric and manual grading are not available.</Text>}
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
  const submission = useSubmission();
  const submitter = useUserProfile(submission.profile_id);
  return (
    <Flex direction="column" borderColor="border.muted" borderWidth="2px" borderRadius="md" minW="0px">
      <HStack pl={4} pr={4} pt={2} alignItems="center" justify="space-between" align="center">
        <Box>
          <Heading size="lg">{submission.assignments.title}</Heading>
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
      </HStack>
      <Box
        p={0}
        m={0}
        borderBottomColor="border.emphasized"
        borderBottomWidth="2px"
        bg="bg.muted"
        defaultValue="results"
      >
        <NextLink prefetch={true} href={linkToSubPage(pathname, "results")}>
          <Button variant={pathname.includes("/results") ? "solid" : "ghost"}>
            <Icon as={FaCheckCircle} />
            Grading Summary
          </Button>
        </NextLink>
        <NextLink prefetch={true} href={linkToSubPage(pathname, "files")}>
          <Button variant={pathname.includes("/files") ? "solid" : "ghost"}>
            <Icon as={FaFile} />
            Files
          </Button>
        </NextLink>
      </Box>
      <Box flex={1}>
        <Flex>
          <Box flex={10} pr={4} minW="0">
            {children}
          </Box>
          <Box flex={1} minW="md" maxW="lg">
            <RubricView />
          </Box>
        </Flex>
      </Box>
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
