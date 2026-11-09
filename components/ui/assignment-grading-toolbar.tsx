"use client";

import SubmissionAuthorNames from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/submission-author-names";
import Link from "@/components/ui/link";
import { useMyReviewAssignments } from "@/hooks/useAssignment";
import {
  type ReviewSubmissionOption,
  type SubmissionOption,
  useGroupedSubmissionOptions,
  useMyReviewSubmissionOptions,
  useSubmissionNavigation
} from "@/hooks/useNextIncompleteReview";
import { Box, HStack, Text } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { FaArrowLeft, FaArrowRight, FaChartBar, FaCheckCircle, FaClock } from "react-icons/fa";
import { useNavigationProgress } from "@/components/ui/navigation-progress";

type SubmissionSelectOption = ReviewSubmissionOption & {
  // value represents the submission id (submission-centric selection)
  value: number;
  label: string;
};

type ReviewToolbarStats = {
  totalReviews: number;
  completedReviews: number;
  completionPercent: number;
  allComplete: boolean;
};

// Wraps the shared grouping with the currently selected option for the selector.
function useGroupedSubmissionData() {
  const groups = useGroupedSubmissionOptions();
  const { submissions_id } = useParams();

  return useMemo(() => {
    const currentSubmissionId = submissions_id ? parseInt(submissions_id as string) : null;
    const selectedOption =
      (currentSubmissionId && groups.flatMap((g) => g.options).find((o) => o.value === currentSubmissionId)) || null;
    return { groups, selectedOption, placeholder: "Select any submission to view..." };
  }, [groups, submissions_id]);
}

/** Previous / next links. Both keep the tab the grader is on (see useSubmissionNavigation). */
function PreviousNextLinks({ nextLabel }: { nextLabel: string }) {
  const { previousUrl, nextUrl } = useSubmissionNavigation();
  return (
    <HStack gap={3} fontSize="sm" flex="0 0 auto">
      {previousUrl && (
        <Link href={previousUrl}>
          <FaArrowLeft style={{ marginRight: "4px" }} />
          Previous
        </Link>
      )}
      {nextUrl && (
        <Link href={nextUrl}>
          {nextLabel}
          <FaArrowRight style={{ marginLeft: "4px" }} />
        </Link>
      )}
    </HStack>
  );
}

function SubmissionSelector() {
  const router = useRouter();
  const { groups, selectedOption, placeholder } = useGroupedSubmissionData();
  const { urlFor } = useSubmissionNavigation();
  const { startNavigation } = useNavigationProgress();

  const handleSubmissionSelect = useCallback(
    (option: SubmissionOption | null) => {
      if (option) {
        // urlFor carries no review params, so a stale review assignment never follows a generic jump.
        startNavigation();
        router.push(urlFor(option.value));
      }
    },
    [router, startNavigation, urlFor]
  );

  if (groups.length === 0) {
    return (
      <Box flex="1" maxW="400px">
        <Text fontSize="sm" color="fg.muted">
          No submissions available
        </Text>
      </Box>
    );
  }

  return (
    <Box flex="1" maxW="400px">
      <Select<SubmissionOption>
        placeholder={placeholder}
        options={groups}
        value={selectedOption}
        onChange={handleSubmissionSelect}
        size="sm"
        isSearchable={true}
        formatOptionLabel={(option: SubmissionOption) => (
          <HStack justifyContent="space-between" w="100%">
            <HStack>
              <SubmissionAuthorNames submission_id={option.value} />
            </HStack>
          </HStack>
        )}
      />
    </Box>
  );
}

export { SubmissionSelector };

export default function AssignmentGradingToolbar() {
  const { course_id, assignment_id, submissions_id } = useParams();
  const router = useRouter();
  const myReviewAssignments = useMyReviewAssignments();
  const reviewOptions = useMyReviewSubmissionOptions();
  const isInReviewMode = myReviewAssignments.length > 0;
  const { urlFor } = useSubmissionNavigation();
  const { startNavigation } = useNavigationProgress();

  const { selectOptions, currentlySelected, stats } = useMemo(() => {
    if (!isInReviewMode) {
      return {
        selectOptions: [] as SubmissionSelectOption[],
        currentlySelected: null,
        stats: null as ReviewToolbarStats | null
      };
    }

    const options: SubmissionSelectOption[] = reviewOptions.map((opt) => ({
      ...opt,
      value: opt.submissionId,
      label: `Submission ${opt.submissionId}`
    }));

    const currentSubmissionId = submissions_id ? parseInt(submissions_id as string) : undefined;
    const selected = currentSubmissionId
      ? options.find((opt) => opt.submissionId === currentSubmissionId) || null
      : null;

    const totalReviews = myReviewAssignments.length;
    const completedReviews = myReviewAssignments.filter((ra) => ra.completed_at).length;
    const completionPercent = totalReviews > 0 ? Math.round((completedReviews / totalReviews) * 100) : 0;
    const allComplete = options.every((opt) => opt.allReviewsComplete);

    return {
      selectOptions: options,
      currentlySelected: selected,
      stats: {
        totalReviews,
        completedReviews,
        completionPercent,
        allComplete
      }
    };
  }, [isInReviewMode, reviewOptions, submissions_id, myReviewAssignments]);

  const handleSubmissionSelect = useCallback(
    (option: SubmissionSelectOption | null) => {
      if (option) {
        // Only carry a review assignment if it is an incomplete review for this submission; urlFor
        // drops every other query param, so no stale RA id comes along from a prior selection.
        const reviewAssignmentId = option.hasIncompleteReview ? option.reviewAssignmentId : undefined;
        startNavigation();
        router.push(urlFor(option.submissionId, reviewAssignmentId));
      }
    },
    [router, startNavigation, urlFor]
  );

  if (!isInReviewMode) {
    return (
      <HStack p={2} bg="bg.subtle" borderBottom="1px solid" borderColor="border.muted" w="100%" gap={4}>
        <Link href={`/course/${course_id}/manage/assignments/${assignment_id}`}>
          <FaArrowLeft /> Back to Assignment Home
        </Link>
        <SubmissionSelector />
        <PreviousNextLinks nextLabel="Next" />
      </HStack>
    );
  }

  return (
    <HStack
      p={2}
      bg="bg.subtle"
      border="1px solid"
      borderColor="border.muted"
      w="100%"
      gap={4}
      justifyContent="space-between"
    >
      {/* Left side: Back link and progress */}
      <HStack gap={4} flex="0 0 auto">
        <Link href={`/course/${course_id}/manage/assignments/${assignment_id}`}>
          <FaArrowLeft /> Back to Assignment Home
        </Link>
      </HStack>
      <HStack gap={4} flex="0 0 auto">
        <HStack gap={2}>
          <FaChartBar />
          <Text fontSize="sm">
            Progress:{" "}
            <strong>
              {stats?.completedReviews}/{stats?.totalReviews}
            </strong>{" "}
            ({stats?.completionPercent}%)
          </Text>
        </HStack>

        {/* Center: Submission selector */}
        <Box flex="1" maxW="400px">
          <Select<SubmissionSelectOption>
            placeholder="Select a submission to review..."
            options={selectOptions}
            value={currentlySelected}
            onChange={handleSubmissionSelect}
            size="sm"
            isSearchable={false}
            formatOptionLabel={(option: SubmissionSelectOption) => (
              <HStack justifyContent="space-between" w="100%">
                <SubmissionAuthorNames submission_id={option.submissionId} />
                <HStack gap={1}>
                  {option.allReviewsComplete ? (
                    <>
                      <FaCheckCircle size={12} color="green" />
                      <Text fontSize="xs" color="green.600">
                        All reviews complete ({option.completedReviews}/{option.totalReviews})
                      </Text>
                    </>
                  ) : (
                    <>
                      <FaClock size={12} color="orange" />
                      <Text fontSize="xs" color="orange.600">
                        {option.completedReviews}/{option.totalReviews} complete
                      </Text>
                    </>
                  )}
                </HStack>
              </HStack>
            )}
          />
        </Box>

        {/* Right side: Previous / Next Incomplete, or the all-done note */}
        <HStack gap={3} flex="0 0 auto">
          {stats?.allComplete && (
            <Text color="fg.muted" fontSize="sm">
              All reviews completed!
            </Text>
          )}
          <PreviousNextLinks nextLabel="Next Incomplete" />
        </HStack>
      </HStack>
    </HStack>
  );
}
