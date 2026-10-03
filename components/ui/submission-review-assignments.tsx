"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import PersonName from "@/components/ui/person-name";
import {
  useAssignmentController,
  useReviewAssignmentRubricParts,
  useRubricById,
  useRubricParts
} from "@/hooks/useAssignment";
import { useClassProfiles, useIsInstructor } from "@/hooks/useClassProfiles";
import { useGradersAndInstructors } from "@/hooks/useCourseController";
import { useIsTableControllerReady, useTableControllerTableValues } from "@/lib/TableController";
import type { ReviewAssignments } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Heading, HStack, Skeleton, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";

function ReviewAssignmentRow({ reviewAssignment }: { reviewAssignment: ReviewAssignments }) {
  const { private_profile_id } = useClassProfiles();
  const rubric = useRubricById(reviewAssignment.rubric_id);
  const assignedParts = useReviewAssignmentRubricParts(reviewAssignment.id);
  const allParts = useRubricParts(reviewAssignment.rubric_id);
  const partNames = useMemo(
    () =>
      assignedParts
        .map((part) => allParts?.find((p) => p.id === part.rubric_part_id)?.name)
        .filter(Boolean)
        .join(", "),
    [assignedParts, allParts]
  );
  const isMine = reviewAssignment.assignee_profile_id === private_profile_id;

  return (
    <Box
      w="100%"
      data-testid={`review-assignment-${reviewAssignment.id}`}
      borderTopWidth="1px"
      borderColor="border.muted"
      pt={2}
    >
      {/* Stacked rather than side-by-side: the rubric sidebar can be narrow, and a right-hand
          column got clipped by its overflow-x: hidden. */}
      <VStack align="start" gap={0} minW={0}>
        <HStack gap={2} flexWrap="wrap">
          <Text fontSize="sm">
            <Text as="span" fontWeight="semibold">
              <PersonName uid={reviewAssignment.assignee_profile_id} showAvatar={false} />
            </Text>
            {isMine ? " (you)" : ""}
          </Text>
          <Badge size="sm" colorPalette={reviewAssignment.completed_at ? "green" : "orange"}>
            {reviewAssignment.completed_at ? "Complete" : "Pending"}
          </Badge>
        </HStack>
        <Text fontSize="xs" color="fg.muted">
          {rubric?.name ?? "Rubric"}
          {partNames ? ` · ${partNames}` : " · whole rubric"}
        </Text>
        {reviewAssignment.completed_at ? (
          <Text fontSize="xs" color="fg.muted" data-visual-test="transparent" data-visual-placeholder="review-status">
            Completed <TimeZoneAwareDate date={reviewAssignment.completed_at} format="MMM d, h:mm a" />
            {reviewAssignment.completed_by &&
              reviewAssignment.completed_by !== reviewAssignment.assignee_profile_id && (
                <>
                  {" "}
                  by <PersonName uid={reviewAssignment.completed_by} showAvatar={false} />
                </>
              )}
          </Text>
        ) : (
          <Text fontSize="xs" color="fg.muted" data-visual-test="transparent" data-visual-placeholder="review-status">
            Due <TimeZoneAwareDate date={reviewAssignment.due_date} format="MMM d, h:mm a" />
          </Text>
        )}
      </VStack>
    </Box>
  );
}

/**
 * Who is assigned to grade this submission. Each row names the assignee, the rubric part(s), and
 * the status; each grader completes their own assignment from the toolbar.
 *
 * Instructors see every assignment on the submission. Graders can read only their own
 * review_assignments rows (RLS), so for them this lists just their own, and says "Not assigned to
 * you" rather than claiming nobody has the submission.
 */
export default function SubmissionReviewAssignments({ submissionId }: { submissionId: number }) {
  const controller = useAssignmentController();
  const isInstructor = useIsInstructor();
  // The grader-scoped controller is already loaded for the toolbar; instructors read the full one.
  const source = isInstructor ? controller.allReviewAssignments : controller.reviewAssignments;
  const ready = useIsTableControllerReady(source);
  const rows = useTableControllerTableValues(source);
  const staff = useGradersAndInstructors();
  const { private_profile_id } = useClassProfiles();

  const staffIds = useMemo(() => new Set(staff.map((p) => p.id)), [staff]);
  // Grading assignments only. A student's self-review is a review assignment too, but it is shown
  // with its own rubric in the sidebar, and listing it here would read as "assigned to the student".
  const forSubmission = useMemo(
    () =>
      rows
        .filter((ra) => ra.submission_id === submissionId && staffIds.has(ra.assignee_profile_id))
        // Mine first, then by due date, so the row the viewer acts on is on top.
        .sort((a, b) => {
          const aMine = a.assignee_profile_id === private_profile_id ? 0 : 1;
          const bMine = b.assignee_profile_id === private_profile_id ? 0 : 1;
          if (aMine !== bMine) return aMine - bMine;
          return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
        }),
    [rows, submissionId, private_profile_id, staffIds]
  );

  return (
    <Box
      w="100%"
      p={2}
      borderWidth="1px"
      borderRadius="md"
      borderColor="border.default"
      data-testid="submission-review-assignments"
    >
      <Heading as="h2" size="sm" mb={1}>
        Grading assigned to
      </Heading>
      {!ready || staff.length === 0 ? (
        <Skeleton height="40px" />
      ) : forSubmission.length === 0 ? (
        <Text fontSize="sm" color="fg.muted">
          {isInstructor ? "Not assigned to anyone." : "Not assigned to you."}
        </Text>
      ) : (
        <VStack align="start" gap={2} w="100%">
          {forSubmission.map((ra) => (
            <ReviewAssignmentRow key={ra.id} reviewAssignment={ra as ReviewAssignments} />
          ))}
        </VStack>
      )}
    </Box>
  );
}
