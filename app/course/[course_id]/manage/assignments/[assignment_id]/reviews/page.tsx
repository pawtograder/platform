"use client";

import { useMemo } from "react";
import { Heading, IconButton, Container, HStack, Table, Text, Spinner } from "@chakra-ui/react";
import { useList, useDelete } from "@refinedev/core";
import { useParams } from "next/navigation";
import { FaTrash, FaEdit, FaPlus } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import PersonName from "@/components/ui/person-name";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { toaster, Toaster } from "@/components/ui/toaster";
import useModalManager from "@/hooks/useModalManager";
import AssignReviewModal from "./assignReviewModal";

// Type definitions
type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];
type RubricRow = Database["public"]["Tables"]["rubrics"]["Row"];
type AssignmentRow = Database["public"]["Tables"]["assignments"]["Row"];
type AssignmentGroupRow = Database["public"]["Tables"]["assignment_groups"]["Row"];
type SubmissionReviewRow = Database["public"]["Tables"]["submission_reviews"]["Row"];

type PopulatedSubmission = SubmissionRow & {
  profiles?: ProfileRow;
  assignment_groups?: AssignmentGroupRow & {
    assignment_groups_members?: { profiles: ProfileRow }[];
  };
  assignments?: AssignmentRow;
  submission_reviews?: SubmissionReviewRow[];
};

type PopulatedReviewAssignment = ReviewAssignmentRow & {
  profiles?: ProfileRow;
  submissions?: PopulatedSubmission;
  rubrics?: RubricRow;
  meta: {
    select: "*, profiles!assignee_profile_id(*), rubrics(*), submissions(*, profiles!profile_id(*), assignment_groups(*, assignment_groups_members(*,profiles!profile_id(*))), assignments(*), submission_reviews(completed_at, grader, rubric_id, submission_id))";
  };
  review_assignment_rubric_parts?: { rubric_part_id: number }[];
};

// Main Page Component
export default function ReviewAssignmentsPage() {
  const { course_id, assignment_id } = useParams();
  const {
    isOpen: isAssignModalOpen,
    modalData: assignModalData,
    openModal: openAssignModal,
    closeModal: closeAssignModal
  } = useModalManager<PopulatedReviewAssignment | null>();

  const {
    data: reviewAssignmentsData,
    isLoading: isLoadingReviewAssignments,
    refetch
  } = useList<PopulatedReviewAssignment>({
    resource: "review_assignments",
    filters: [{ field: "assignment_id", operator: "eq", value: Number(assignment_id) }],
    sorters: [{ field: "created_at", order: "desc" }],
    meta: {
      select:
        "*, profiles!assignee_profile_id(*), rubrics(*), submissions(*, profiles!profile_id(*), assignment_groups(*, assignment_groups_members(*,profiles!profile_id(*))), assignments(*), submission_reviews(completed_at, grader, rubric_id, submission_id))"
    }
  });

  const { mutate: deleteReviewAssignment } = useDelete();

  const handleDelete = (id: number) => {
    deleteReviewAssignment(
      {
        resource: "review_assignments",
        id: id
      },
      {
        onSuccess: () => {
          toaster.success({ title: "Review assignment deleted" });
          refetch();
        },
        onError: (error) => {
          toaster.error({ title: "Error deleting review assignment", description: error.message });
        }
      }
    );
  };

  const reviewAssignments = useMemo(() => reviewAssignmentsData?.data || [], [reviewAssignmentsData]);

  const getReviewStatus = (ra: PopulatedReviewAssignment): string => {
    if (!ra.submissions || !ra.submissions.submission_reviews) {
      // If submission_reviews are not loaded, check due date for pending/late
      if (ra.due_date && new Date(ra.due_date) < new Date()) {
        return "Late";
      }
      return "Pending";
    }

    const matchingReview = ra.submissions.submission_reviews.find(
      (sr) =>
        sr.submission_id === ra.submission_id && sr.grader === ra.assignee_profile_id && sr.rubric_id === ra.rubric_id
    );

    if (matchingReview) {
      if (matchingReview.completed_at) {
        return "Completed";
      }
      if (ra.due_date && new Date(ra.due_date) < new Date()) {
        return "Late";
      }
      return "In Progress";
    }

    if (ra.due_date && new Date(ra.due_date) < new Date()) {
      return "Late";
    }
    return "Pending";
  };

  return (
    <Container maxW="container.xl" py={4}>
      <Toaster />
      <HStack justifyContent="space-between" mb={4}>
        <Heading size="lg">Manage Review Assignments</Heading>
        <Button
          onClick={() => {
            openAssignModal(null);
          }}
          variant="solid"
          colorPalette="blue"
        >
          <FaPlus style={{ marginRight: "8px" }} /> Assign Reviews
        </Button>
      </HStack>

      {isLoadingReviewAssignments && <Spinner />}
      {!isLoadingReviewAssignments && reviewAssignments.length === 0 && (
        <Text>No review assignments found for this assignment.</Text>
      )}

      {!isLoadingReviewAssignments && reviewAssignments.length > 0 && (
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Assignee</Table.ColumnHeader>
              <Table.ColumnHeader>Submission (Student/Group)</Table.ColumnHeader>
              <Table.ColumnHeader>Rubric</Table.ColumnHeader>
              <Table.ColumnHeader>Due Date</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Actions</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {reviewAssignments.map((ra) => {
              const submission = ra.submissions;
              let submitterName = "N/A";
              if (submission) {
                if (submission.assignment_groups && submission.assignment_groups.name) {
                  submitterName = `Group: ${submission.assignment_groups.name}`;
                } else if (submission.profiles && submission.profiles.name) {
                  submitterName = submission.profiles.name;
                } else {
                  submitterName = `Submission ID: ${submission.id}`;
                }
              }
              const displayStatus = getReviewStatus(ra);

              return (
                <Table.Row key={ra.id}>
                  <Table.Cell>
                    {ra.profiles?.name ? <PersonName uid={ra.assignee_profile_id} /> : ra.assignee_profile_id}
                  </Table.Cell>
                  <Table.Cell>{submitterName}</Table.Cell>
                  <Table.Cell>{ra.rubrics?.name || "N/A"}</Table.Cell>
                  <Table.Cell>{ra.due_date ? new Date(ra.due_date).toLocaleDateString() : "N/A"}</Table.Cell>
                  <Table.Cell>{displayStatus}</Table.Cell>
                  <Table.Cell textAlign="center">
                    <HStack gap={1} justifyContent="center">
                      <IconButton
                        aria-label="Edit review assignment"
                        onClick={() => {
                          openAssignModal(ra);
                        }}
                        variant="ghost"
                      >
                        <FaEdit />
                      </IconButton>
                      <PopConfirm
                        triggerLabel="Delete review assignment"
                        confirmHeader="Delete Review Assignment"
                        confirmText="Are you sure you want to delete this review assignment?"
                        onConfirm={() => handleDelete(ra.id)}
                        onCancel={() => {}}
                        trigger={
                          <IconButton aria-label="Delete review assignment" colorScheme="red" variant="ghost" size="sm">
                            <FaTrash />
                          </IconButton>
                        }
                      />
                    </HStack>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      )}

      {isAssignModalOpen && (
        <AssignReviewModal
          isOpen={isAssignModalOpen}
          onClose={closeAssignModal}
          courseId={Number(course_id)}
          assignmentId={Number(assignment_id)}
          onSuccess={() => {
            refetch();
            closeAssignModal();
          }}
          initialData={assignModalData}
          isEditing={!!assignModalData}
        />
      )}
    </Container>
  );
}
