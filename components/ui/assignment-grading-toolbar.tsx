"use client";

import SubmissionAuthorNames from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/submission-author-names";
import Link from "@/components/ui/link";
import { useActiveSubmissions, useAssignmentGroups, useMyReviewAssignments } from "@/hooks/useAssignment";
import { useAllProfilesForClass, useGradersAndInstructors } from "@/hooks/useCourseController";
import { Box, HStack, Text } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { FaArrowLeft, FaArrowRight, FaChartBar, FaCheckCircle, FaClock } from "react-icons/fa";
import { useNavigationProgress } from "@/components/ui/navigation-progress";

interface SubmissionSelectOption {
  // value represents the submission id (submission-centric selection)
  value: number;
  label: string;
  submissionId: number;
  // optional review assignment id associated to this submission (prefer incomplete)
  reviewAssignmentId?: number;
  // whether there is an incomplete review for me on this submission
  hasIncompleteReview: boolean;
  // whether all review assignments for this submission (for me) are complete
  allReviewsComplete: boolean;
  // counts for display purposes
  totalReviews: number;
  completedReviews: number;
}

type ReviewToolbarStats = {
  totalReviews: number;
  completedReviews: number;
  completionPercent: number;
  allComplete: boolean;
  nextIncomplete: { reviewAssignmentId: number; submissionId: number } | null;
};

// Data types for grouped submission selector
interface SubmissionOption {
  value: number;
  label: string;
  authorName: string;
  isStudent: boolean;
}

interface SubmissionGroup {
  label: string;
  options: SubmissionOption[];
}

interface GroupedSubmissionData {
  groups: SubmissionGroup[];
  selectedOption: SubmissionOption | null;
  placeholder: string;
}

// Hook that returns grouped submission data for the selector
function useGroupedSubmissionData(): GroupedSubmissionData {
  const submissions = useActiveSubmissions();
  const classProfiles = useAllProfilesForClass();
  const assignmentGroups = useAssignmentGroups();
  const staffProfiles = useGradersAndInstructors();
  const { submissions_id } = useParams();

  return useMemo(() => {
    const studentSubmissions: SubmissionOption[] = [];
    const staffSubmissions: SubmissionOption[] = [];

    // Process each submission
    submissions.forEach((submission) => {
      // Get author name
      let authorName = "";
      if (submission.profile_id) {
        // Individual submission - get profile name
        const profile = classProfiles.find((p) => p.id === submission.profile_id);
        authorName = profile?.name || `Submission ${submission.id}`;
      } else if (submission.assignment_group_id) {
        // Group submission - get group name
        const group = assignmentGroups.find((g) => g.id === submission.assignment_group_id);
        authorName = group?.name || `Group ${submission.assignment_group_id}`;
      } else {
        authorName = `Submission ${submission.id}`;
      }

      // Determine if author is a student
      let isStudent = true; // Default to student
      if (submission.profile_id) {
        // Check if the profile belongs to a student role
        const userRole = staffProfiles.find((p) => p.id === submission.profile_id);
        isStudent = !userRole;
      }

      const option: SubmissionOption = {
        value: submission.id,
        label: authorName,
        authorName,
        isStudent
      };

      if (isStudent) {
        studentSubmissions.push(option);
      } else {
        staffSubmissions.push(option);
      }
    });

    // Create grouped options
    const groups: SubmissionGroup[] = [];

    // Add students group
    if (studentSubmissions.length > 0) {
      groups.push({
        label: "Students",
        options: studentSubmissions.sort((a, b) => a.label.localeCompare(b.label))
      });
    }

    // Add staff group if there are any staff submissions
    if (staffSubmissions.length > 0) {
      groups.push({
        label: "Instructors & Graders",
        options: staffSubmissions.sort((a, b) => a.label.localeCompare(b.label))
      });
    }

    // Find the currently selected option
    let selectedOption: SubmissionOption | null = null;
    const currentSubmissionId = submissions_id ? parseInt(submissions_id as string) : null;

    if (currentSubmissionId) {
      // Search through all groups to find the selected option
      for (const group of groups) {
        const found = group.options.find((option) => option.value === currentSubmissionId);
        if (found) {
          selectedOption = found;
          break;
        }
      }
    }

    return {
      groups,
      selectedOption,
      placeholder: "Select any submission to view..."
    };
  }, [submissions, classProfiles, assignmentGroups, submissions_id, staffProfiles]);
}

function SubmissionSelector() {
  const { course_id, assignment_id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { groups, selectedOption, placeholder } = useGroupedSubmissionData();
  const { startNavigation } = useNavigationProgress();

  const handleSubmissionSelect = useCallback(
    (option: SubmissionOption | null) => {
      if (option) {
        const params = new URLSearchParams(searchParams.toString());
        // Strip review-specific params when navigating generically
        params.delete("review_assignment_id");
        params.delete("ignore_review");
        params.delete("selected_review_id");
        const qs = params.toString();
        const url = `/course/${course_id}/assignments/${assignment_id}/submissions/${option.value}/files${qs ? `?${qs}` : ""}`;
        startNavigation();
        router.push(url);
      }
    },
    [course_id, assignment_id, router, searchParams, startNavigation]
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
  const searchParams = useSearchParams();
  const myReviewAssignments = useMyReviewAssignments();
  const isInReviewMode = myReviewAssignments.length > 0;
  const { startNavigation } = useNavigationProgress();

  // Group review assignments by submission id
  const reviewAssignmentsBySubmission = useMemo(() => {
    const grouped = new Map<number, typeof myReviewAssignments>();
    myReviewAssignments.forEach((assignment) => {
      const existing = grouped.get(assignment.submission_id) || [];
      grouped.set(assignment.submission_id, [...existing, assignment]);
    });
    return grouped;
  }, [myReviewAssignments]);

  const { selectOptions, currentlySelected, stats } = useMemo(() => {
    if (!isInReviewMode) {
      return {
        selectOptions: [] as SubmissionSelectOption[],
        currentlySelected: null,
        stats: null as ReviewToolbarStats | null
      };
    }

    // Build one option per submission that has review assignments for me
    const options: SubmissionSelectOption[] = Array.from(reviewAssignmentsBySubmission.entries()).map(
      ([submissionId, assignments]) => {
        const allComplete = assignments.every((ra) => ra.completed_at);
        const anyIncomplete = assignments.some((ra) => !ra.completed_at);
        const primaryAssignment = assignments.find((ra) => !ra.completed_at) || assignments[0];
        const completedCount = assignments.filter((ra) => ra.completed_at).length;

        return {
          value: submissionId,
          label: `Submission ${submissionId}`,
          submissionId,
          reviewAssignmentId: primaryAssignment?.id,
          hasIncompleteReview: anyIncomplete,
          allReviewsComplete: allComplete,
          totalReviews: assignments.length,
          completedReviews: completedCount
        };
      }
    );

    // Sort so that incomplete submissions appear first, stable by submission id
    options.sort((a, b) => {
      if (a.hasIncompleteReview && !b.hasIncompleteReview) return -1;
      if (!a.hasIncompleteReview && b.hasIncompleteReview) return 1;
      return a.submissionId - b.submissionId;
    });

    const currentSubmissionId = submissions_id ? parseInt(submissions_id as string) : undefined;
    const selected = currentSubmissionId
      ? options.find((opt) => opt.submissionId === currentSubmissionId) || null
      : null;

    const totalReviews = myReviewAssignments.length;
    const completedReviews = myReviewAssignments.filter((ra) => ra.completed_at).length;
    const completionPercent = totalReviews > 0 ? Math.round((completedReviews / totalReviews) * 100) : 0;
    const allComplete = options.every((opt) => opt.allReviewsComplete);

    // Find next submission with any incomplete reviews (after current), else wrap to first incomplete
    const nextIncompleteOption =
      options.find((opt) => opt.hasIncompleteReview && (!selected || opt.submissionId > selected.submissionId)) ||
      options.find((opt) => opt.hasIncompleteReview);

    const nextIncomplete = nextIncompleteOption
      ? (() => {
          const ras = reviewAssignmentsBySubmission.get(nextIncompleteOption.submissionId) ?? [];
          const target = ras.find((ra) => !ra.completed_at) ?? ras[0];
          return target ? { reviewAssignmentId: target.id, submissionId: target.submission_id } : null;
        })()
      : null;

    return {
      selectOptions: options,
      currentlySelected: selected,
      stats: {
        totalReviews,
        completedReviews,
        completionPercent,
        allComplete,
        nextIncomplete
      }
    };
  }, [isInReviewMode, reviewAssignmentsBySubmission, submissions_id, myReviewAssignments]);

  const handleSubmissionSelect = useCallback(
    (option: SubmissionSelectOption | null) => {
      if (option) {
        const reviewId = option.reviewAssignmentId;
        const params = new URLSearchParams(searchParams.toString());
        // Only set review assignment if it is an incomplete review for this submission
        if (option.hasIncompleteReview && reviewId) {
          params.set("review_assignment_id", String(reviewId));
          params.delete("ignore_review");
          params.delete("selected_review_id");
        } else {
          // Ensure no stale RA id is carried over from a prior selection
          params.delete("review_assignment_id");
          params.delete("ignore_review");
          params.delete("selected_review_id");
        }
        const qs = params.toString();
        const url = `/course/${course_id}/assignments/${assignment_id}/submissions/${option.submissionId}/files${qs ? `?${qs}` : ""}`;
        startNavigation();
        router.push(url);
      }
    },
    [course_id, assignment_id, router, searchParams, startNavigation]
  );

  if (!isInReviewMode) {
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

        {/* Right side: Navigation buttons and status badges */}
        <HStack gap={3} flex="0 0 auto">
          {/* Quick navigation: next incomplete if any, else show all done */}
          <HStack gap={3} fontSize="sm">
            {stats && !stats.allComplete && stats.nextIncomplete ? (
              <Link
                href={`/course/${course_id}/assignments/${assignment_id}/submissions/${stats.nextIncomplete.submissionId}/files?review_assignment_id=${stats.nextIncomplete.reviewAssignmentId}`}
              >
                <FaArrowRight style={{ marginRight: "4px" }} />
                Next Incomplete
              </Link>
            ) : stats?.allComplete ? (
              <Text color="fg.muted" fontSize="sm">
                All reviews completed!
              </Text>
            ) : null}
          </HStack>
        </HStack>
      </HStack>
    </HStack>
  );
}
