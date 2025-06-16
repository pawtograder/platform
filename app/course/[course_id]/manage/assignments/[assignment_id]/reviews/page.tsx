"use client";

import { Checkbox, Container, Dialog, Field, Fieldset, Flex, HStack, Heading, Text } from "@chakra-ui/react";
import { useInvalidate, useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { FaPlus } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import useModalManager from "@/hooks/useModalManager";
import AssignReviewModal from "./assignReviewModal";
import ReviewsTable, { PopulatedReviewAssignment } from "./ReviewsTable";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Select } from "chakra-react-select";
import { useEffect, useState } from "react";
import { Submission, SubmissionReview, UserRole } from "@/utils/supabase/DatabaseTypes";
import { LuCheck } from "react-icons/lu";

type RubricRow = Database["public"]["Tables"]["rubrics"]["Row"];
type ReviewAssignmentRow = Database["public"]["Tables"]["review_assignments"]["Row"];
type SubmissionWithGrading = Submission & {
  submission_reviews: SubmissionReview[];
  review_assignments: ReviewAssignmentRow[];
};

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
  };

  return (
    <Container maxW="container.xl" py={4}>
      <Toaster />
      <ReviewAssignmentBulkModal />

      <HStack justifyContent="space-between" mb={4}>
        <Heading size="lg">Manage Review Assignments</Heading>
        <Button
          onClick={() => {
            openAssignModal(null);
          }}
          variant="solid"
        >
          <FaPlus style={{ marginRight: "8px" }} /> Assign Reviews
        </Button>
      </HStack>

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

export function ReviewAssignmentBulkModal() {
  const { course_id, assignment_id } = useParams();
  const [selectedRubric, setSelectedRubric] = useState<RubricRow>();
  const [submissionsToDo, setSubmissionsToDo] = useState<SubmissionWithGrading[]>();
  const [role, setRole] = useState<String>();

  const { data: gradingRubrics } = useList<RubricRow>({
    resource: "rubrics",
    meta: {
      select: "*"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "assignment_id", operator: "eq", value: assignment_id },
      { field: "review_round", operator: "ne", value: "self-review" }
    ]
  });

  const { data: activeSubmissions } = useList<SubmissionWithGrading>({
    resource: "submissions",
    meta: {
      select:
        "*, submission_reviews!submission_reviews_submission_id_fkey(*), review_assignments!review_assignments_submission_id_fkey(*)"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "assignment_id", operator: "eq", value: assignment_id },
      { field: "is_active", operator: "eq", value: true },
      { field: "submission_reviews.rubric_id", operator: "eq", value: selectedRubric?.id },
      { field: "review_assignments.rubric_id", operator: "eq", value: selectedRubric?.id }
    ],
    queryOptions: {
      enabled: !!selectedRubric
    }
  });

  const { data: courseStaff } = useList<UserRole>({
    resource: "user_roles",
    meta: {
      select: "*"
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "role", operator: "in", value: ["grader", "instructor"] }
    ]
  });

  useEffect(() => {
    if (selectedRubric && activeSubmissions?.data) {
      setSubmissionsToDo(
        activeSubmissions?.data.filter((sub) => {
          return sub.submission_reviews.length === 0 && sub.review_assignments.length === 0;
        })
      );
    }
  }, [activeSubmissions, selectedRubric]);

  /**
   * options for assigning grading
   * - split evenly between graders OR graders and instructors OR instructors
   * - split between any of these combinations, but consider how many submissions they've already graded (for the course or for this assignment?)
   * - some way to manually reallocate the numbers -> validation to ensure the total staged to be assigned is the right number at the end of these edits
   * - should take grading conflicts into consideration
   * - option to set a deadline for when grading should be completed by -> make sure instructor can change this in case TAs are late
   *
   * - eventually, be able to reallocate one person's grading in case of an emergency
   *
   * q? how might these be affected by late submissions
   *
   * select field: assign grading to : graders, instructors, instructors and graders
   * checkbox field: consider how many submissions they've graded so far when splitting
   * generate button: splits people to be assigned to each of the graders/instructors which were selected, considering grading conflicts
   * preview: once generated, show each ta/instructor and their tentative assigned assignments to grade, along with the number of people in parentheses
   * next to their name
   * to edit -- potentially drag the students between tas? -> dnd - kit
   *
   *
   */

  return (
    <Dialog.Root size="lg" placement={"center"}>
      <Dialog.Trigger asChild>
        <Button>Assign Grading</Button>
      </Dialog.Trigger>
      <Dialog.Positioner>
        <Dialog.Backdrop />
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Assign grading</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Fieldset.Root>
              <Fieldset.Content>
                <Field.Root>
                  <Field.Label>Choose rubric</Field.Label>
                  <Select
                    onChange={(e) => setSelectedRubric(e?.value)}
                    options={gradingRubrics?.data.map((rubric) => {
                      return { label: rubric.name, value: rubric };
                    })}
                  />
                </Field.Root>
                <Text>
                  There are {submissionsToDo?.length ?? 0} active submissions that are unassigned and ungraded for this
                  rubric on this assignment.
                </Text>
                <Field.Root>
                  <Field.Label>Select role to assign reviews to</Field.Label>
                  <Select
                    onChange={(e) => setRole(e?.value)}
                    options={[
                      { label: "Instructors", value: "instuctors" },
                      { label: "Graders", value: "graders" },
                      { label: "Instructors and graders", value: "instuctors and graders" }
                    ]}
                  />
                </Field.Root>
                <Field.Root>
                  <Flex gap="5">
                    <Checkbox.Root onCheckedChange={(e) => {}}>
                      <Checkbox.Control>
                        <LuCheck />
                      </Checkbox.Control>

                      <Checkbox.HiddenInput />
                    </Checkbox.Root>
                    <Field.Label>
                      Consider the number of submissions each person has graded already when splitting
                    </Field.Label>
                  </Flex>
                </Field.Root>
                <Button></Button>
              </Fieldset.Content>
            </Fieldset.Root>
            <Dialog.Footer>Close</Dialog.Footer>
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
