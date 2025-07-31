"use client";

import Link from "@/components/ui/link";
import { useActiveSubmissions, useMyReviewAssignments, useReviewAssignment } from "@/hooks/useAssignment";
import { HStack, Text, Box } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { FaArrowLeft, FaArrowRight, FaCheckCircle, FaClock, FaChartBar } from "react-icons/fa";
import { Select } from "chakra-react-select";
import { formatRelative } from "date-fns";
import SubmissionAuthorNames from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/submission-author-names";

interface SubmissionOptionRendererProps {
  submissionId: number;
  assignmentReviewId?: number;
}

function SubmissionOptionRenderer({ submissionId, assignmentReviewId }: SubmissionOptionRendererProps) {
  const review = useReviewAssignment(assignmentReviewId);
  return (
    <HStack justifyContent="space-between" w="100%">
      <HStack>
        <SubmissionAuthorNames submission_id={submissionId} />
      </HStack>
      <HStack>
        {review?.completed_at ? (
          <HStack gap={1}>
            <FaCheckCircle size={12} color="green" />
            <Text fontSize="xs" color="green.600">
              {review.completed_at ? formatRelative(new Date(review.completed_at), new Date()) : "Completed"}
            </Text>
          </HStack>
        ) : (
          <HStack gap={1}>
            <FaClock size={12} color="orange" />
            <Text fontSize="xs" color="orange.600">
              Pending
            </Text>
          </HStack>
        )}
      </HStack>
    </HStack>
  );
}

interface SubmissionSelectOption {
  value: number;
  label: string;
}

interface AllSubmissionSelectOption {
  value: number;
  label: string;
}

function SubmissionSelector() {
  const { course_id, assignment_id, submissions_id } = useParams();
  const router = useRouter();
  const submissions = useActiveSubmissions();

  const { selectOptions, currentlySelected } = useMemo(() => {
    // Create select options for all submissions
    const options: AllSubmissionSelectOption[] = submissions.map((submission) => ({
      value: submission.id,
      label: `Submission ${submission.id}`
    }));

    // Find the currently selected option based on the submissions_id from URL
    const currentSubmissionId = submissions_id ? parseInt(submissions_id as string) : null;
    const selected = currentSubmissionId ? options.find((option) => option.value === currentSubmissionId) : null;

    return {
      selectOptions: options,
      currentlySelected: selected || null
    };
  }, [submissions, submissions_id]);

  const handleSubmissionSelect = useCallback(
    (option: AllSubmissionSelectOption | null) => {
      if (option) {
        const url = `/course/${course_id}/assignments/${assignment_id}/submissions/${option.value}/files`;
        router.push(url);
      }
    },
    [course_id, assignment_id, router]
  );

  if (submissions.length === 0) {
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
      <Select<AllSubmissionSelectOption>
        placeholder="Select any submission to view..."
        options={selectOptions}
        value={currentlySelected}
        onChange={handleSubmissionSelect}
        size="sm"
        isSearchable={false}
        formatOptionLabel={(option: AllSubmissionSelectOption) => (
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

  const { numCompleted, nextUncompleted, lastCompleted, completionPercent, selectOptions, currentlySelected } =
    useMemo(() => {
      const completed = myReviewAssignments.filter((review) => review.completed_at);
      const uncompleted = myReviewAssignments.filter((review) => !review.completed_at);
      const last = completed[completed.length - 1]; // Last completed
      const percent =
        myReviewAssignments.length > 0 ? Math.round((completed.length / myReviewAssignments.length) * 100) : 0;

      // Create select options for all review assignments
      const options: SubmissionSelectOption[] = myReviewAssignments.map((review) => ({
        value: review.submission_id,
        label: `Submission ${review.submission_id}`
      }));

      // Find the currently selected option based on the submissions_id from URL
      const currentSubmissionId = submissions_id ? parseInt(submissions_id as string) : null;
      const selected = currentSubmissionId ? options.find((option) => option.value === currentSubmissionId) : null;

      // Find next uncompleted relative to current position in the select order
      let nextUncompleted = null;
      if (uncompleted.length > 0) {
        const currentIndex = selected ? options.findIndex((opt) => opt.value === selected.value) : -1;

        // Start searching from the position after current, or from beginning if no current selection
        const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;

        // Search from current position forward
        for (let i = startIndex; i < options.length; i++) {
          const review = myReviewAssignments.find((r) => r.submission_id === options[i].value);
          if (review && !review.completed_at) {
            nextUncompleted = review;
            break;
          }
        }

        // If nothing found, wrap around and search from beginning to current position
        if (!nextUncompleted && currentIndex > 0) {
          for (let i = 0; i < currentIndex; i++) {
            const review = myReviewAssignments.find((r) => r.submission_id === options[i].value);
            if (review && !review.completed_at) {
              nextUncompleted = review;
              break;
            }
          }
        }

        // If still nothing found and no current selection, just take first uncompleted
        if (!nextUncompleted && currentIndex < 0) {
          nextUncompleted = uncompleted[0];
        }
      }

      return {
        numCompleted: completed.length,
        nextUncompleted,
        lastCompleted: last,
        completionPercent: percent,
        selectOptions: options,
        currentlySelected: selected || null
      };
    }, [myReviewAssignments, submissions_id]);

  const handleSubmissionSelect = useCallback(
    (option: SubmissionSelectOption | null) => {
      if (option) {
        const review = myReviewAssignments.find((r) => r.submission_id === option.value);
        const reviewId = review?.id;
        const url = `/course/${course_id}/assignments/${assignment_id}/submissions/${option.value}/files${reviewId ? `?review_assignment_id=${reviewId}` : ""}`;
        router.push(url);
      }
    },
    [course_id, assignment_id, router, myReviewAssignments]
  );

  if (myReviewAssignments.length === 0) {
    return (
      <HStack p={2} bg="bg.subtle" borderBottom="1px solid" borderColor="border.muted" w="100%">
        <Link href={`/course/${course_id}/manage/assignments/${assignment_id}`}>
          <FaArrowLeft /> Back to Assignment Home
        </Link>
        <SubmissionSelector />
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
              {numCompleted}/{myReviewAssignments.length}
            </strong>{" "}
            ({completionPercent}%)
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
            formatOptionLabel={(option: SubmissionSelectOption) => {
              const review = myReviewAssignments.find((r) => r.submission_id === option.value);
              return <SubmissionOptionRenderer submissionId={option.value} assignmentReviewId={review?.id} />;
            }}
          />
        </Box>

        {/* Right side: Navigation buttons and status badges */}
        <HStack gap={3} flex="0 0 auto">
          {/* Quick navigation buttons */}
          <HStack gap={3} fontSize="sm">
            {nextUncompleted ? (
              <Link
                href={`/course/${course_id}/assignments/${assignment_id}/submissions/${nextUncompleted.submission_id}/files?review_assignment_id=${nextUncompleted.id}`}
              >
                <FaArrowRight style={{ marginRight: "4px" }} />
                Next Uncompleted
              </Link>
            ) : (
              <Text color="fg.muted" fontSize="sm">
                All completed!
              </Text>
            )}

            {lastCompleted && (
              <Link
                href={`/course/${course_id}/assignments/${assignment_id}/submissions/${lastCompleted.submission_id}/files?review_assignment_id=${lastCompleted.id}`}
                colorPalette="green"
              >
                Last Completed
                <FaCheckCircle style={{ marginLeft: "4px" }} />
              </Link>
            )}
          </HStack>
        </HStack>
      </HStack>
    </HStack>
  );
}
