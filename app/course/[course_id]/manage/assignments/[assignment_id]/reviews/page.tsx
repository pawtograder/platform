"use client";

import { Button } from "@/components/ui/button";
import {
  DialogActionTrigger,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import Link from "@/components/ui/link";
import { toaster, Toaster } from "@/components/ui/toaster";
import useModalManager from "@/hooks/useModalManager";
import { createClient } from "@/utils/supabase/client";
import * as Sentry from "@sentry/nextjs";
import {
  ReviewAssignmentParts,
  ReviewAssignments,
  Rubric,
  RubricPart,
  Submission,
  SubmissionReview,
  UserRole
} from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Container, Field, Heading, HStack, List, Separator, Text, VStack } from "@chakra-ui/react";
import { useInvalidate, useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MdClear } from "react-icons/md";
import { GradingConflictWithPopulatedProfiles } from "../../../course/grading-conflicts/gradingConflictsTable";
import AssignReviewModal from "./assignReviewModal";
import ReviewsTable, { PopulatedReviewAssignment } from "./ReviewsTable";

type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];

export type ReviewAssignmentsWithParts = ReviewAssignments & {
  review_assignment_rubric_parts: ReviewAssignmentParts[];
};

export type SubmissionWithGrading = Submission & {
  submission_reviews: SubmissionReview[];
  review_assignments: ReviewAssignmentsWithParts[];
  assignment_groups: {
    assignment_groups_members: {
      profile_id: string;
    }[];
  } | null;
};

export type UserRoleWithConflictsAndName = UserRole & {
  profiles: {
    grading_conflicts: GradingConflictWithPopulatedProfiles[];
    name: string;
  };
};

export type DraftReviewAssignment = {
  assignee: UserRoleWithConflictsAndName;
  submitters: UserRoleWithConflictsAndName[];
  submission: SubmissionWithGrading;
  part?: RubricPart;
};

export type RubricWithParts = Rubric & { rubric_parts: RubricPart[] };

// Clear Assignments Dialog Component
function ClearAssignmentsDialog({ onAssignmentCleared }: { onAssignmentCleared: () => void }) {
  const { course_id, assignment_id } = useParams();
  const supabase = createClient();
  const [selectedRubric, setSelectedRubric] = useState<RubricWithParts>();
  const [isClearing, setIsClearing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  // Reset selected rubric when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedRubric(undefined);
    }
  }, [isOpen]);

  const { data: gradingRubrics } = useList<RubricWithParts>({
    resource: "rubrics",
    meta: {
      select: "*, rubric_parts!rubric_parts_rubric_id_fkey(*)"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "assignment_id", operator: "eq", value: assignment_id },
      { field: "review_round", operator: "ne", value: "self-review" } // Exclude self-review
    ],
    queryOptions: {
      enabled: !!course_id && !!assignment_id
    }
  });

  const { data: reviewAssignments } = useList({
    resource: "review_assignments",
    meta: {
      select:
        "*, submissions!review_assignments_submission_id_fkey(submission_reviews!submission_reviews_submission_id_fkey(completed_at, grader, rubric_id))"
    },
    filters: [
      { field: "assignment_id", operator: "eq", value: assignment_id },
      { field: "rubric_id", operator: "eq", value: selectedRubric?.id }
    ],
    queryOptions: {
      enabled: !!selectedRubric && !!assignment_id
    },
    pagination: {
      pageSize: 1000
    }
  });

  const incompleteAssignments =
    (
      reviewAssignments?.data as
        | (ReviewAssignmentRow & {
            submissions?: { submission_reviews?: { completed_at: string | null; grader: string; rubric_id: number }[] };
          })[]
        | undefined
    )?.filter((assignment) => {
      // Check if the assignment has no completed review
      const hasCompletedReview = assignment.submissions?.submission_reviews?.some(
        (review) =>
          review.completed_at &&
          review.grader === assignment.assignee_profile_id &&
          review.rubric_id === assignment.rubric_id
      );
      return !hasCompletedReview;
    }) || [];

  const handleClearAssignments = async () => {
    if (!selectedRubric || incompleteAssignments.length === 0) return;

    setIsClearing(true);
    try {
      // Add Sentry breadcrumb for tracking
      Sentry.addBreadcrumb({
        message: "Starting clear all incomplete assignments",
        category: "clear_all_assignments",
        data: {
          course_id: Number(course_id),
          assignment_id: Number(assignment_id),
          rubric_name: selectedRubric.name,
          incomplete_count: incompleteAssignments.length
        },
        level: "info"
      });

      // Call the clear_all_incomplete_review_assignments RPC
      const { data: result, error: rpcError } = await supabase.rpc("clear_all_incomplete_review_assignments", {
        p_class_id: Number(course_id),
        p_assignment_id: Number(assignment_id)
      });

      if (rpcError) {
        Sentry.addBreadcrumb({
          message: "Clear all assignments RPC failed",
          category: "clear_all_assignments",
          data: { error: rpcError.message, code: rpcError.code },
          level: "error"
        });

        toaster.error({
          title: "Error Clearing Assignments",
          description: rpcError.message || "Failed to clear incomplete assignments"
        });
        return;
      }

      // Type cast the result for proper access to properties
      const typedResult = result as {
        success: boolean;
        error?: string;
        assignments_deleted: number;
        parts_deleted: number;
        message?: string;
      };

      if (!typedResult?.success) {
        Sentry.addBreadcrumb({
          message: "Clear all assignments RPC returned failure",
          category: "clear_all_assignments",
          data: { result: typedResult },
          level: "error"
        });

        toaster.error({
          title: "Error Clearing Assignments",
          description: typedResult?.error || "Unknown error occurred while clearing assignments"
        });
        return;
      }

      // Log successful operation
      Sentry.addBreadcrumb({
        message: "Clear all assignments completed successfully",
        category: "clear_all_assignments",
        data: {
          assignments_deleted: typedResult.assignments_deleted,
          parts_deleted: typedResult.parts_deleted
        },
        level: "info"
      });

      toaster.success({
        title: "Assignments Cleared",
        description: `Successfully cleared ${typedResult.assignments_deleted} incomplete assignments across all rubrics`
      });

      onAssignmentCleared();
      setIsOpen(false);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Failed to clear assignments";

      Sentry.addBreadcrumb({
        message: "Clear all assignments failed with exception",
        category: "clear_all_assignments",
        data: { error: errMsg },
        level: "error"
      });

      toaster.error({
        title: "Error Clearing Assignments",
        description: errMsg
      });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <DialogRoot open={isOpen} onOpenChange={(e) => setIsOpen(e.open)}>
      <DialogTrigger asChild>
        <Button variant="outline" colorPalette="red">
          <MdClear style={{ marginRight: "8px" }} /> Clear Assignments
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear Assignments</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <VStack align="stretch" gap={4}>
            <Field.Root>
              <Field.Label>Select rubric to clear assignments from</Field.Label>
              <Select
                value={selectedRubric ? { label: selectedRubric.name, value: selectedRubric } : null}
                onChange={(e) => setSelectedRubric(e?.value)}
                options={gradingRubrics?.data.map((rubric) => ({
                  label: rubric.name,
                  value: rubric
                }))}
                placeholder="Choose a rubric..."
              />
              <Field.HelperText>Self-review rubrics are not included in this list</Field.HelperText>
            </Field.Root>

            {selectedRubric && (
              <Box p={4} bg="warning.subtle" border="1px solid" borderColor="warning.border" borderRadius="md">
                <Text fontWeight="bold" color="warning.fg" mb={2}>
                  ⚠️ Warning
                </Text>
                <Text color="warning.fg" mb={2}>
                  This action will permanently delete all incomplete review assignments for the &ldquo;
                  {selectedRubric.name}&rdquo; rubric.
                </Text>
                <List.Root color="warning.fg" fontSize="sm">
                  <List.Item>{incompleteAssignments.length} incomplete assignment(s) will be deleted</List.Item>
                  <List.Item>Only assignments that have not been completed will be removed</List.Item>
                  <List.Item>This action cannot be undone</List.Item>
                </List.Root>
              </Box>
            )}
          </VStack>
        </DialogBody>
        <DialogFooter>
          <DialogActionTrigger asChild>
            <Button variant="outline">Cancel</Button>
          </DialogActionTrigger>
          <Button
            onClick={handleClearAssignments}
            disabled={!selectedRubric || incompleteAssignments.length === 0 || isClearing}
            colorPalette="red"
            loading={isClearing}
          >
            {isClearing ? "Clearing..." : `Clear ${incompleteAssignments.length} Assignment(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

// Main Page Component
export default function ReviewAssignmentsPage() {
  const { course_id, assignment_id } = useParams();
  const invalidate = useInvalidate();
  const {
    isOpen: isAssignModalOpen,
    modalData: assignModalData,
    openModal: openAssignModal,
    closeModal: closeAssignModal
  } = useModalManager<PopulatedReviewAssignment | null>();

  const handleReviewAssignmentChange = () => {
    invalidate({ resource: "review_assignments", invalidates: ["list"] });
    invalidate({ resource: "submissions", invalidates: ["list"] });
  };

  return (
    <Container maxW="container.xl" py={4}>
      <Toaster />

      <Heading size="lg">Manage Review Assignments</Heading>
      <Separator mb={4} />

      <VStack align="stretch" gap={4} mb={6}>
        <Heading size="md">Assignment Management</Heading>
        <HStack gap={4} wrap="wrap">
          <Link href={`/course/${course_id}/manage/assignments/${assignment_id}/reviews/bulk-assign`}>
            Bulk Assign Grading
          </Link>
          <Link href={`/course/${course_id}/manage/assignments/${assignment_id}/reviews/reassign`}>
            Reassign Grading by Grader
          </Link>
          <Button onClick={() => openAssignModal(null)} variant="ghost" size="sm">
            Assign Single Review
          </Button>
          <ClearAssignmentsDialog onAssignmentCleared={handleReviewAssignmentChange} />
        </HStack>
      </VStack>

      <Heading size="md">Current Assignments</Heading>
      <Separator w="100%" mb={2} />
      <ReviewsTable
        assignmentId={assignment_id as string}
        openAssignModal={openAssignModal}
        onReviewAssignmentDeleted={handleReviewAssignmentChange}
      />
      {isAssignModalOpen && (
        <AssignReviewModal
          isOpen={isAssignModalOpen}
          onClose={closeAssignModal}
          courseId={Number(course_id)}
          assignmentId={Number(assignment_id)}
          onSuccess={() => {
            handleReviewAssignmentChange();
            closeAssignModal();
          }}
          initialData={assignModalData}
          isEditing={!!assignModalData}
        />
      )}
    </Container>
  );
}
